import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';

/**
 * Tiny fixed-size LRU cache for blocklisted JTIs.
 *
 * Stores `true` for revoked JTIs so we avoid a Redis round-trip on every
 * request for hot tokens.  Negative results (not blocklisted) are NOT cached
 * here — only positive revocations — so a logout always propagates within
 * the next request at most.
 *
 * Size is capped at 1 000 entries.  When the cap is reached the oldest entry
 * is evicted (insertion-order via Map iteration).
 */
class LruBlocklistCache {
  private readonly map = new Map<string, true>();
  private readonly maxSize: number;

  constructor(maxSize = 1_000) {
    this.maxSize = maxSize;
  }

  has(jti: string): boolean {
    return this.map.has(jti);
  }

  add(jti: string): void {
    if (this.map.size >= this.maxSize) {
      // Evict the oldest entry (first key in insertion order)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(jti, true);
  }
}

/**
 * JWT authentication guard with Redis blocklist check (issue #491).
 *
 * Extends Passport's JwtAuthGuard to add a blocklist lookup after successful
 * signature verification.  An in-memory LRU cache holds confirmed-revoked JTIs
 * so repeated requests with a blocked token skip the Redis call.
 *
 * Latency impact:
 *  - Cache hit  (revoked JTI in LRU)  → <1 ms  (pure in-memory lookup)
 *  - Cache miss (not yet seen JTI)    → +1 Redis GET (async, ~0.3 ms on localhost)
 *
 * Tokens without a `jti` claim are rejected as unrevocable.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly lru = new LruBlocklistCache(1_000);

  constructor(private readonly authService: AuthService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Run the standard Passport JWT verification (signature + expiry).
    const isValid = await (super.canActivate(context) as Promise<boolean>);
    if (!isValid) return false;

    // 2. Extract the jti from the verified payload attached to req.user.
    const request = context.switchToHttp().getRequest<{
      user?: { account: string; jti?: string };
    }>();

    const jti = request.user?.jti;

    // Tokens without jti are legacy — reject them.
    if (!jti) {
      throw new UnauthorizedException(
        'Token cannot be accepted: missing jti claim. Please re-authenticate.',
      );
    }

    // 3. Fast path — LRU cache of confirmed-revoked JTIs.
    if (this.lru.has(jti)) {
      throw new UnauthorizedException('Token has been revoked');
    }

    // 4. Slow path — ask Redis / in-memory cache.
    const revoked = await this.authService.isTokenRevoked(jti);
    if (revoked) {
      this.lru.add(jti); // cache positive result
      throw new UnauthorizedException('Token has been revoked');
    }

    return true;
  }
}
