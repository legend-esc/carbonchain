import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
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
 */
@Injectable()
export class ThrottlerGuard implements CanActivate {
  /** Fallback in-memory store used when Redis is not available. */
  private readonly store = new Map<string, HitRecord>();
  private readonly skipCidrs: CidrEntry[];

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

  private checkIpThrottle(
    context: ExecutionContext,
    options: ThrottleOptions,
  ): boolean {
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

  private extractIp(req: Request): string {
    return (
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        .trim() ??
      req.socket?.remoteAddress ??
      'unknown'
    );
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
