import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

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
  private readonly store = new Map<string, HitRecord>();
  private readonly skipCidrs: CidrEntry[];

  constructor(private readonly reflector: Reflector) {
    const raw = process.env['THROTTLER_SKIP_IPS'] ?? '';
    this.skipCidrs = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseCidr)
      .filter((e): e is CidrEntry => e !== null);
  }

  canActivate(context: ExecutionContext): boolean {
    const options: ThrottleOptions | undefined =
      this.reflector.get<ThrottleOptions>(THROTTLE_KEY, context.getHandler()) ??
      this.reflector.get<ThrottleOptions>(THROTTLE_KEY, context.getClass());

    if (!options) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        .trim() ??
      req.socket.remoteAddress ??
      'unknown';

    // Silently bypass throttling for IPs in the skip list.
    // No bypass headers are written to avoid leaking the allowlist.
    if (isInSkipList(ip, this.skipCidrs)) {
      return true;
    }

    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const record = this.store.get(key);

    if (!record || now > record.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + options.ttl });
      return true;
    }

    if (record.count >= options.limit) {
      throw new HttpException(
        'Too Many Requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count += 1;
    return true;
  }
}
