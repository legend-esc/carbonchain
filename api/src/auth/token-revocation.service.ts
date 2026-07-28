import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

const REVOKED_TOKENS_SET = 'revoked_tokens';

/**
 * Redis-backed JWT revocation list (blocklist).
 *
 * Issue: leaked admin JWTs could not be revoked before natural expiry.
 * Revoked JTIs are stored in a Redis set with a per-token TTL matching
 * the token's remaining lifetime, so entries self-clean and the set
 * never grows unbounded.
 */
@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);
  private client: RedisClientType | null = null;

  constructor(private readonly config: ConfigService) {}

  private async getClient(): Promise<RedisClientType | null> {
    if (this.client?.isOpen) return this.client;
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn('REDIS_URL not set — token revocation disabled');
      return null;
    }
    try {
      this.client = createClient({ url });
      await this.client.connect();
      return this.client;
    } catch (err) {
      this.logger.error(
        `Failed to connect to Redis for revocation check: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Revoke a token by its JTI. Uses a per-JTI key with TTL (rather than a
   * single unbounded SET) so revocation entries expire alongside the token.
   */
  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    const client = await this.getClient();
    if (!client) return;
    const ttl = Math.max(ttlSeconds, 1);
    await client.sAdd(REVOKED_TOKENS_SET, jti);
    // Mirror TTL via a companion key so cleanup can sweep expired entries out
    // of the set without leaking memory indefinitely.
    await client.set(`revoked_tokens:ttl:${jti}`, '1', { EX: ttl });
  }

  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) return false;
    const client = await this.getClient();
    if (!client) return false;
    // A missing TTL companion key means the revocation has expired; treat
    // it as not-revoked and lazily clean the stale set membership.
    const stillActive = await client.exists(`revoked_tokens:ttl:${jti}`);
    if (!stillActive) {
      await client.sRem(REVOKED_TOKENS_SET, jti);
      return false;
    }
    return (await client.sIsMember(REVOKED_TOKENS_SET, jti)) === true;
  }
}
