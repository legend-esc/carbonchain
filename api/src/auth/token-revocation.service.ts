import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type Redis as RedisClient } from 'ioredis';

const REVOKED_TOKENS_SET = 'revoked_tokens';

@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);
  private client: RedisClient | null = null;

  constructor(private readonly config: ConfigService) {}

  private async getClient(): Promise<RedisClient | null> {
    if (this.client?.status === 'ready') return this.client;
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn('REDIS_URL not set — token revocation disabled');
      return null;
    }
    try {
      this.client = new Redis(url);
      await this.client.ping();
      return this.client;
    } catch (err) {
      this.logger.error(
        `Failed to connect to Redis for revocation check: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    const client = await this.getClient();
    if (!client) return;
    const ttl = Math.max(ttlSeconds, 1);
    await client.sadd(REVOKED_TOKENS_SET, jti);
    await client.set(`revoked_tokens:ttl:${jti}`, '1', 'EX', ttl);
  }

  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) return false;
    const client = await this.getClient();
    if (!client) return false;
    const stillActive = await client.exists(`revoked_tokens:ttl:${jti}`);
    if (!stillActive) {
      await client.srem(REVOKED_TOKENS_SET, jti);
      return false;
    }
    return (await client.sismember(REVOKED_TOKENS_SET, jti)) === 1;
  }
}
