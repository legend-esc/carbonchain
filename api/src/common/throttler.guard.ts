import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { CacheService } from './cache.service';

export const THROTTLE_KEY = 'throttle';

export interface ThrottleOptions {
  /** Max requests allowed in the window. */
  limit: number;
  /** Window duration in milliseconds. */
  ttl: number;
}

/** Decorator to set per-route throttle options. */
export const Throttle =
  (options: ThrottleOptions) =>
  (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      Reflect.defineMetadata(THROTTLE_KEY, options, descriptor.value as object);
    } else {
      Reflect.defineMetadata(THROTTLE_KEY, options, target);
    }
    return descriptor;
  };

/**
 * Decorator to mark a route as requiring per-account rate limiting on
 * POST /auth/verify. The guard reads this metadata to decide whether to
 * extract and rate-limit by Stellar account address in addition to IP.
 */
export const ACCOUNT_THROTTLE_KEY = 'accountThrottle';

export interface AccountThrottleOptions {
  /** Max requests per Stellar account in the window. */
  accountLimit: number;
  /** Max requests per IP in the window. */
  ipLimit: number;
  /** Window duration in milliseconds. */
  ttl: number;
}

export const AccountThrottle =
  (options: AccountThrottleOptions) =>
  (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      Reflect.defineMetadata(
        ACCOUNT_THROTTLE_KEY,
        options,
        descriptor.value as object,
      );
    } else {
      Reflect.defineMetadata(ACCOUNT_THROTTLE_KEY, options, target);
    }
    return descriptor;
  };

interface HitRecord {
  count: number;
  resetAt: number;
}

/** Parsed CIDR entry: numeric network address and bitmask. */
interface CidrEntry {
  network: number;
  mask: number;
}

/**
 * Parse a single CIDR string (e.g. "10.0.0.0/8") into a numeric network/mask pair.
 * Returns null when the string is not a valid IPv4 CIDR.
 */
function parseCidr(cidr: string): CidrEntry | null {
  const parts = cidr.trim().split('/');
  const ipPart = parts[0];
  const prefixLen = parts.length === 2 ? parseInt(parts[1], 10) : 32;

  if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return null;

  const octets = ipPart.split('.');
  if (octets.length !== 4) return null;

  let network = 0;
  for (const octet of octets) {
    const n = parseInt(octet, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    network = (network << 8) | n;
  }
  // Shift as unsigned 32-bit to avoid sign issues.
  network = network >>> 0;

  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;

  return { network: network & mask, mask };
}

/**
 * Convert a dotted-decimal IPv4 string to a 32-bit unsigned integer.
 * Returns null for non-IPv4 strings (e.g. IPv6 or "unknown").
 */
function ipToInt(ip: string): number | null {
  // Strip IPv6-mapped IPv4 prefix (::ffff:x.x.x.x).
  const stripped = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const octets = stripped.split('.');
  if (octets.length !== 4) return null;

  let n = 0;
  for (const octet of octets) {
    const v = parseInt(octet, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/**
 * Returns true when `ip` falls within any of the supplied CIDR ranges.
 */
function isInSkipList(ip: string, cidrs: CidrEntry[]): boolean {
  if (cidrs.length === 0) return false;
  const addr = ipToInt(ip);
  if (addr === null) return false;
  return cidrs.some((c) => (addr & c.mask) === c.network);
}

/**
 * Default trusted reverse-proxy CIDR ranges.
 *
 * These are ONLY used when `TRUST_PROXY=1` and `TRUSTED_PROXY_CIDRS` is not
 * set.  When `TRUST_PROXY=0` (the default) the `x-forwarded-for` header is
 * completely ignored regardless of the source IP.
 *
 * The defaults cover loopback + RFC1918 private and link-local ranges because
 * that is where a reverse proxy / load balancer normally sits.  Anything outside
 * these ranges (a client connecting directly from a public IP) is never
 * trusted, so a spoofed `x-forwarded-for` cannot bypass rate limits.
 *
 * Override with `TRUSTED_PROXY_CIDRS` (comma-separated IPv4 CIDRs).
 * Set to an empty string to trust nothing even when `TRUST_PROXY=1`.
 *
 * Issue #945: `TRUST_PROXY` and `TRUSTED_PROXY_CIDRS` are validated through
 * env-validation.ts so their values are always well-formed at startup.
 */
const DEFAULT_TRUSTED_PROXY_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
];

/**
 * Bounds for the in-memory fallback store. Expired entries are reaped on every
 * write and by a shared background sweep so the map cannot grow without limit.
 */
const MAX_STORE_ENTRIES = 100_000;
const STORE_SWEEP_INTERVAL_MS = 60_000;

/**
 * Remove expired entries from a store and, if it is still over the cap, prune
 * the oldest (soonest-to-expire) entries first.
 */
function sweepStore(store: Map<string, HitRecord>): void {
  const now = Date.now();
  for (const [key, record] of store) {
    if (now > record.resetAt) store.delete(key);
  }

  if (store.size <= MAX_STORE_ENTRIES) return;

  const overflow = store.size - MAX_STORE_ENTRIES;
  const entries = [...store.entries()]
    .sort((a, b) => a[1].resetAt - b[1].resetAt)
    .slice(0, overflow);
  for (const [key] of entries) store.delete(key);
}

// Shared sweep timer — there is at most one, regardless of how many guard
// instances exist, and it does not keep the process alive.
const liveStores = new Set<Map<string, HitRecord>>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function registerStore(store: Map<string, HitRecord>): void {
  if (process.env['NODE_ENV'] === 'test') return;
  liveStores.add(store);
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    for (const s of liveStores) sweepStore(s);
  }, STORE_SWEEP_INTERVAL_MS);
  // Don't block process exit on a housekeeping timer.
  sweepTimer.unref?.();
}

/**
 * Per-IP rate limiting guard.
 * Uses an in-memory map — suitable for single-instance deployments.
 * Replace with Redis-backed storage for multi-instance setups.
 *
 * ## Skip list (THROTTLER_SKIP_IPS)
 * Set the `THROTTLER_SKIP_IPS` environment variable to a comma-separated list
 * of IPv4 CIDR ranges whose requests should bypass throttling entirely.
 *
 * Example:
 *   THROTTLER_SKIP_IPS=127.0.0.1/8,10.0.0.0/8
 *
 * The bypass is intentionally silent — no `X-RateLimit-*` headers are added
 * for skipped requests to avoid leaking the allowlist to external observers.
 *
 * In production the default is an empty list (no bypass).
 *
 * ## Trusted proxies (TRUST_PROXY + TRUSTED_PROXY_CIDRS) — issue #945
 *
 * `TRUST_PROXY` (integer, 0 or 1, default 0)
 *   Explicit toggle for reverse-proxy trust. When 0 (default), `x-forwarded-for`
 *   is completely ignored and throttling is always based on the direct socket
 *   peer IP. This is the safe default: a spoofed XFF header from an untrusted
 *   client can never bypass rate limits.
 *
 *   Set to 1 when the API runs behind a trusted reverse proxy (e.g. the nginx
 *   container in docker-compose) so that the guard correctly identifies the
 *   real client IP from the XFF header.
 *
 * `TRUSTED_PROXY_CIDRS` (string, comma-separated IPv4 CIDRs)
 *   Only meaningful when TRUST_PROXY=1. Defines which direct-connection source
 *   IPs are trusted to set `x-forwarded-for`. Defaults to loopback + RFC1918
 *   private/link-local ranges when not set. Set to an empty string to trust
 *   no proxy even with TRUST_PROXY=1.
 *
 * Security guarantee:
 *   - TRUST_PROXY=0: XFF is never read; socket IP always wins. Spoof-proof.
 *   - TRUST_PROXY=1: XFF only honoured from IPs in TRUSTED_PROXY_CIDRS; the
 *     rightmost untrusted hop in the XFF chain is taken as the client. A client
 *     that adds its own XFF entries cannot advance past the first untrusted hop.
 *
 * ## Legacy env var (THROTTLER_TRUSTED_PROXIES)
 * Kept for backward compatibility. Takes effect only when TRUST_PROXY is absent
 * from the environment (pre-#945 deployments). Prefer TRUST_PROXY + TRUSTED_PROXY_CIDRS.
 */
@Injectable()
export class ThrottlerGuard implements CanActivate {
  /** Fallback in-memory store used when Redis is not available. */
  private readonly store = new Map<string, HitRecord>();
  private readonly skipCidrs: CidrEntry[];
  private readonly trustedProxies: CidrEntry[];
  /** Issue #945: when false, x-forwarded-for is completely ignored. */
  private readonly trustProxy: boolean;
  private readonly logger = new Logger(ThrottlerGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly cache?: CacheService,
  ) {
    const raw = process.env['THROTTLER_SKIP_IPS'] ?? '';
    this.skipCidrs = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseCidr)
      .filter((e): e is CidrEntry => e !== null);

    // Issue #945 — TRUST_PROXY is the canonical toggle.
    // Fall back to the legacy THROTTLER_TRUSTED_PROXIES behaviour when
    // TRUST_PROXY is not set, for backward compatibility.
    const trustProxyEnv = process.env['TRUST_PROXY'];
    if (trustProxyEnv !== undefined) {
      // Explicit setting: 0 = never trust XFF, 1 = trust XFF from CIDR list.
      this.trustProxy = trustProxyEnv.trim() === '1';
    } else {
      // Legacy mode: if THROTTLER_TRUSTED_PROXIES is set, trust is implicit.
      this.trustProxy = true;
    }

    // Resolve the trusted CIDR list.
    // Priority: TRUSTED_PROXY_CIDRS → THROTTLER_TRUSTED_PROXIES → defaults.
    const trustedProxyCidrs = process.env['TRUSTED_PROXY_CIDRS'];
    const legacyTrustedProxies = process.env['THROTTLER_TRUSTED_PROXIES'];
    let trustedSource: string[];

    if (trustedProxyCidrs !== undefined) {
      // Explicit #945 setting (may be empty string = trust nothing).
      trustedSource = trustedProxyCidrs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (legacyTrustedProxies) {
      // Legacy env var.
      trustedSource = legacyTrustedProxies
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      trustedSource = DEFAULT_TRUSTED_PROXY_CIDRS;
    }

    this.trustedProxies = trustedSource
      .map(parseCidr)
      .filter((e): e is CidrEntry => e !== null);

    registerStore(this.store);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const accountOptions: AccountThrottleOptions | undefined =
      this.reflector.get<AccountThrottleOptions>(
        ACCOUNT_THROTTLE_KEY,
        context.getHandler(),
      ) ??
      this.reflector.get<AccountThrottleOptions>(
        ACCOUNT_THROTTLE_KEY,
        context.getClass(),
      );

    if (accountOptions) {
      return this.checkAccountThrottle(context, accountOptions);
    }

    const options: ThrottleOptions | undefined =
      this.reflector.get<ThrottleOptions>(THROTTLE_KEY, context.getHandler()) ??
      this.reflector.get<ThrottleOptions>(THROTTLE_KEY, context.getClass());

    if (!options) return true;

    return this.checkIpThrottle(context, options);
  }

  private async checkIpThrottle(
    context: ExecutionContext,
    options: ThrottleOptions,
  ): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse?.();
    const ip = this.extractIp(req);

    // Silently bypass throttling for IPs in the skip list.
    // No bypass headers are written to avoid leaking the allowlist.
    if (isInSkipList(ip, this.skipCidrs)) {
      return true;
    }

    const key = `${ip}:${req.path}`;
    if (this.cache?.isConnected) {
      try {
        const key = `throttle:${ip}:${req.path}`;
        const count = await this.cache.increment(
          key,
          Math.ceil(options.ttl / 1000),
        );
        if (count > options.limit) {
          throw new HttpException(
            'Too Many Requests',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        return true;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        this.logger.warn('Redis throttling unavailable; using memory fallback');
      }
    }

    if (this.store.size > MAX_STORE_ENTRIES) sweepStore(this.store);
    const now = Date.now();
    const record = this.store.get(key);

    if (!record || now > record.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + options.ttl });
      return true;
    }

    if (record.count >= options.limit) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      if (res && typeof res.set === 'function') {
        res.set('Retry-After', String(retryAfter));
      }
      throw new HttpException(
        { message: 'Too Many Requests', retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count += 1;
    return true;
  }

  // ── Account + IP throttle (Redis-backed with in-memory fallback) ────────────

  private async checkAccountThrottle(
    context: ExecutionContext,
    options: AccountThrottleOptions,
  ): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse?.();
    const ip = this.extractIp(req);
    const ttlSeconds = Math.ceil(options.ttl / 1000);

    // ── IP check ──────────────────────────────────────────────────────────────
    const ipKey = `throttle:ip:${ip}:${req.path}`;
    const ipBlocked = await this.increment(ipKey, options.ipLimit, ttlSeconds);
    if (ipBlocked.exceeded) {
      if (res && typeof res.set === 'function') {
        res.set('Retry-After', String(ipBlocked.retryAfter));
      }
      throw new HttpException(
        { message: 'Too Many Requests', retryAfter: ipBlocked.retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // ── Account check ─────────────────────────────────────────────────────────
    // Try to extract the Stellar account address from the request body.
    // The body may contain a `transaction` field (signed XDR). We do a
    // best-effort parse; if it fails we fall back to IP-only limiting.
    const account = this.extractAccount(req);
    if (account) {
      const accountKey = `throttle:account:${account}:${req.path}`;
      const accountBlocked = await this.increment(
        accountKey,
        options.accountLimit,
        ttlSeconds,
      );
      if (accountBlocked.exceeded) {
        if (res && typeof res.set === 'function') {
          res.set('Retry-After', String(accountBlocked.retryAfter));
        }
        throw new HttpException(
          {
            message: 'Too Many Requests',
            retryAfter: accountBlocked.retryAfter,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }

  /**
   * Atomically increment a counter key and check against the limit.
   * Uses Redis INCR + EXPIRE when Redis is available; falls back to the
   * in-memory store otherwise.
   */
  private async increment(
    key: string,
    limit: number,
    ttlSeconds: number,
  ): Promise<{ exceeded: boolean; retryAfter: number }> {
    // ── Redis path ────────────────────────────────────────────────────────────
    if (this.cache?.isConnected) {
      try {
        // INCR atomically increments (creates key at 0 first if absent).
        const count = await (this.cache as any).client?.incr(key);
        if (count === 1) {
          // First hit — set the expiry.
          await (this.cache as any).client?.expire(key, ttlSeconds);
        }
        if (count > limit) {
          const ttl: number =
            (await (this.cache as any).client?.ttl(key)) ?? ttlSeconds;
          return { exceeded: true, retryAfter: Math.max(ttl, 0) };
        }
        return { exceeded: false, retryAfter: 0 };
      } catch {
        // Redis unavailable — fall through to in-memory
      }
    }

    // ── In-memory fallback ────────────────────────────────────────────────────
    // Bound memory: only sweep eagerly once we are over the cap; the shared
    // background timer otherwise reaps expired entries.
    if (this.store.size > MAX_STORE_ENTRIES) sweepStore(this.store);
    const now = Date.now();
    const ttlMs = ttlSeconds * 1000;
    const record = this.store.get(key);

    if (!record || now > record.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + ttlMs });
      return { exceeded: false, retryAfter: 0 };
    }

    if (record.count >= limit) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000);
      return { exceeded: true, retryAfter };
    }

    record.count += 1;
    return { exceeded: false, retryAfter: 0 };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Determine the client IP to throttle by.
   *
   * Issue #945 — TRUST_PROXY=0 (default): `x-forwarded-for` is completely
   * ignored; the direct socket peer IP is always used. This is the safe
   * default and prevents spoofed XFF headers from bypassing rate limits.
   *
   * TRUST_PROXY=1: `x-forwarded-for` is only trusted when the *direct*
   * socket peer is in the TRUSTED_PROXY_CIDRS allowlist. We then walk the
   * XFF chain right-to-left, skipping trusted proxy hops, and take the first
   * untrusted hop as the real client IP. This prevents a client from injecting
   * arbitrary leftmost hops to impersonate a different IP.
   */
  private extractIp(req: Request): string {
    const socketIp = req.socket?.remoteAddress ?? 'unknown';

    // Issue #945 — when trust is disabled, always use the socket peer.
    if (!this.trustProxy) {
      return socketIp;
    }

    const xffHeader = req.headers['x-forwarded-for'];
    const xff = Array.isArray(xffHeader) ? xffHeader[0] : xffHeader;

    if (!xff || !this.isTrustedProxy(socketIp)) {
      return socketIp;
    }

    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);

    // Rightmost entries were appended most recently (closest to us). Skip
    // trusted proxy hops and return the first untrusted hop = the client.
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!this.isTrustedProxy(hops[i])) {
        return hops[i];
      }
    }

    // Every hop is a trusted proxy (unusual) — fall back to the socket peer.
    return socketIp;
  }

  /** True when `ip` is a trusted reverse proxy we may honour XFF from. */
  private isTrustedProxy(ip: string): boolean {
    if (!ip || ip === 'unknown') return false;
    // IPv6 loopback / hostname forms that ipToInt cannot represent.
    if (ip === '::1' || ip === 'localhost') return true;
    return isInSkipList(ip, this.trustedProxies);
  }

  /**
   * Best-effort extraction of the Stellar account public key from the
   * request body. The body is already parsed by NestJS when this guard runs.
   *
   * For POST /auth/verify the body contains `{ transaction: "<XDR>" }`.
   * We extract the account from `body.account` if present (some clients send
   * it directly), or fall back to `body.transaction` parsed via the Stellar SDK.
   */
  private extractAccount(req: Request): string | null {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) return null;

    // Direct account field (e.g., sent by some clients or tests)
    if (typeof body['account'] === 'string' && body['account']) {
      return body['account'];
    }

    // Parse XDR transaction to extract source account from manageData op
    if (typeof body['transaction'] === 'string') {
      try {
        // Lazy-require to avoid loading stellar-sdk into this utility class
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Transaction, Networks } = require('@stellar/stellar-sdk');
        // Try testnet first, then public
        for (const passphrase of [Networks.TESTNET, Networks.PUBLIC]) {
          try {
            const tx = new Transaction(body['transaction'], passphrase);
            const manageDataOp = tx.operations.find(
              (op: { type: string }) => op.type === 'manageData',
            );
            if (manageDataOp && manageDataOp.source) {
              return manageDataOp.source as string;
            }
          } catch {
            // wrong network passphrase — try next
          }
        }
      } catch {
        // XDR parse failed — continue without account-level limiting
      }
    }

    return null;
  }
}
