import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

/**
 * TTL-based Redis cache service.
 *
 * Falls back to a no-op (in-memory disabled) mode when REDIS_URL is not set,
 * so the API starts cleanly in environments without Redis.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client: RedisClientType | null = null;
  private readonly defaultTtlSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.defaultTtlSeconds = config.get<number>('CACHE_TTL_SECONDS', 60);
  }

  /** Connect to Redis. Called by CacheModule on application bootstrap. */
  async connect(): Promise<void> {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn(
        'REDIS_URL not set — caching disabled (in-memory fallback)',
      );
      return;
    }

    try {
      this.client = createClient({ url });
      this.client.on('error', (err: Error) =>
        this.logger.error(`Redis client error: ${err.message}`),
      );
      await this.client.connect();
      this.logger.log(`Connected to Redis at ${url}`);
    } catch (err) {
      this.logger.error(
        `Failed to connect to Redis: ${(err as Error).message}`,
      );
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
  }

  /**
   * Retrieve a cached value. Returns `null` on cache miss or when Redis is unavailable.
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(
        `Cache GET failed for key "${key}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Store a value with an optional TTL (seconds). Defaults to CACHE_TTL_SECONDS env var.
   */
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    try {
      const ttl = ttlSeconds ?? this.defaultTtlSeconds;
      await this.client.set(key, JSON.stringify(value), { EX: ttl });
    } catch (err) {
      this.logger.warn(
        `Cache SET failed for key "${key}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Delete one or more keys. Used for cache invalidation.
   */
  async del(...keys: string[]): Promise<void> {
    if (!this.client || keys.length === 0) return;
    try {
      await this.client.del(keys);
    } catch (err) {
      this.logger.warn(
        `Cache DEL failed for keys [${keys.join(', ')}]: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Delete all keys matching a glob pattern (e.g. `credits:*`).
   */
  async delPattern(pattern: string): Promise<void> {
    if (!this.client) return;
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(keys);
        this.logger.debug(
          `Invalidated ${keys.length} keys matching "${pattern}"`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Cache DEL pattern "${pattern}" failed: ${(err as Error).message}`,
      );
    }
  }

  /** Returns true when a live Redis connection is available. */
  get isConnected(): boolean {
    return this.client !== null && this.client.isOpen;
  }
}
