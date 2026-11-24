/**
 * #1302 — Tiered rate-limiting guard.
 *
 * Extracts the client tier from either a valid JWT Bearer token or an
 * X-API-Key header and applies one of three Redis-backed rate-limit counters:
 *
 *   Anonymous               — 60 req / min
 *   Authenticated User      — 300 req / min
 *   Verified Oracle/Partner — 1200 req / min
 *
 * When Redis is unavailable the guard degrades to an in-memory fallback
 * (single-instance only) using the same counter shape.
 *
 * Response headers on every request:
 *   X-RateLimit-Limit     — quota for this tier
 *   X-RateLimit-Remaining — requests left in the current window
 *   X-RateLimit-Reset     — Unix epoch seconds when the window resets
 *
 * On 429 the response additionally carries:
 *   Retry-After           — seconds until the client may retry
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { CacheService } from '../cache.service';

// ── Tier definitions ──────────────────────────────────────────────────────────

export type RateLimitTier = 'anonymous' | 'authenticated' | 'oracle';

interface TierConfig {
  /** Requests per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

const TIER_CONFIG: Record<RateLimitTier, TierConfig> = {
  anonymous: { limit: 60, windowSeconds: 60 },
  authenticated: { limit: 300, windowSeconds: 60 },
  oracle: { limit: 1200, windowSeconds: 60 },
};

/** Header name used to carry a partner / oracle API key. */
const API_KEY_HEADER = 'x-api-key';

/**
 * Oracle/Partner API keys are stored (in production) as a comma-separated
 * list in the ORACLE_API_KEYS environment variable so they can be injected
 * via secrets manager without a database round-trip on every request.
 *
 * Example:
 *   ORACLE_API_KEYS=sk_oracle_abc123,sk_partner_xyz789
 */
function loadOracleApiKeys(): Set<string> {
  const raw = process.env['ORACLE_API_KEYS'] ?? '';
  return new Set(raw.split(',').map((k) => k.trim()).filter(Boolean));
}

// ── In-memory fallback ────────────────────────────────────────────────────────

interface HitRecord {
  count: number;
  resetAt: number; // Unix ms
}

// ── Guard ─────────────────────────────────────────────────────────────────────

@Injectable()
export class CustomThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(CustomThrottlerGuard.name);
  private readonly store = new Map<string, HitRecord>();

  constructor(@Optional() private readonly cache?: CacheService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const tier = this.resolveTier(req);
    const config = TIER_CONFIG[tier];

    const ip = this.extractIp(req);
    const key = `tiered-throttle:${tier}:${ip}`;

    const result = await this.increment(key, config.limit, config.windowSeconds);

    // Set informational rate-limit headers on every response.
    if (typeof res.set === 'function') {
      res.set('X-RateLimit-Limit', String(config.limit));
      res.set(
        'X-RateLimit-Remaining',
        String(Math.max(0, config.limit - result.count)),
      );
      res.set('X-RateLimit-Reset', String(result.resetEpoch));
    }

    if (result.exceeded) {
      const retryAfter = result.resetEpoch - Math.floor(Date.now() / 1000);
      if (typeof res.set === 'function') {
        res.set('Retry-After', String(Math.max(0, retryAfter)));
      }
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too Many Requests',
          tier,
          retryAfter: Math.max(0, retryAfter),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  // ── Tier resolution ────────────────────────────────────────────────────────

  /**
   * Resolves the client's rate-limit tier.
   *
   * Priority:
   *  1. X-API-Key present and in ORACLE_API_KEYS set  → oracle
   *  2. Authorization: Bearer <jwt> present            → authenticated
   *     (We only check the header's presence; full JWT verification is
   *      handled by JwtAuthGuard on protected routes. This avoids duplicating
   *      signature verification inside the throttler.)
   *  3. Otherwise                                      → anonymous
   */
  resolveTier(req: Request): RateLimitTier {
    const apiKey =
      typeof req.headers[API_KEY_HEADER] === 'string'
        ? (req.headers[API_KEY_HEADER] as string)
        : Array.isArray(req.headers[API_KEY_HEADER])
          ? (req.headers[API_KEY_HEADER] as string[])[0]
          : undefined;

    if (apiKey) {
      const oracleKeys = loadOracleApiKeys();
      if (oracleKeys.has(apiKey)) {
        return 'oracle';
      }
    }

    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      return 'authenticated';
    }

    return 'anonymous';
  }

  // ── Counter ────────────────────────────────────────────────────────────────

  /**
   * Atomically increments a rate-limit counter.
   * Uses Redis INCR + EXPIRE when Redis is available; in-memory fallback otherwise.
   */
  private async increment(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ count: number; exceeded: boolean; resetEpoch: number }> {
    // ── Redis path ────────────────────────────────────────────────────────────
    if (this.cache?.isConnected) {
      try {
        const count = await (this.cache as any).client?.incr(key);
        const countNum: number = typeof count === 'number' ? count : Number(count ?? 1);

        if (countNum === 1) {
          await (this.cache as any).client?.expire(key, windowSeconds);
        }

        const ttlRaw: unknown = await (this.cache as any).client?.ttl(key);
        const ttl: number = typeof ttlRaw === 'number' ? ttlRaw : windowSeconds;
        const resetEpoch = Math.floor(Date.now() / 1000) + Math.max(0, ttl);

        return {
          count: countNum,
          exceeded: countNum > limit,
          resetEpoch,
        };
      } catch (err) {
        this.logger.warn(
          `Redis rate-limit counter failed; using in-memory fallback: ${(err as Error).message}`,
        );
        // Fall through to in-memory.
      }
    }

    // ── In-memory fallback ────────────────────────────────────────────────────
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const record = this.store.get(key);

    if (!record || now > record.resetAt) {
      const resetAt = now + windowMs;
      this.store.set(key, { count: 1, resetAt });
      return {
        count: 1,
        exceeded: false,
        resetEpoch: Math.floor(resetAt / 1000),
      };
    }

    record.count += 1;
    return {
      count: record.count,
      exceeded: record.count > limit,
      resetEpoch: Math.floor(record.resetAt / 1000),
    };
  }

  // ── IP extraction ──────────────────────────────────────────────────────────

  private extractIp(req: Request): string {
    return req.socket?.remoteAddress ?? 'unknown';
  }
}
