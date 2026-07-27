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
   *
   * Scans the whole keyspace via `KEYS` — O(n) in total key count and blocks
   * the event loop under load. Prefer `setTagged`/`invalidateTag` for cache
   * entries that need targeted invalidation.
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

  private tagSetKey(tag: string): string {
    return `cache:tag:${tag}`;
  }

  /**
   * Store a value and register its key against one or more tags, so it can
   * later be invalidated with `invalidateTag` in O(members-of-tag) time
   * instead of scanning the whole keyspace.
   */
  async setTagged(
    key: string,
    value: unknown,
    tags: string[],
    ttlSeconds?: number,
  ): Promise<void> {
    if (!this.client) return;
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    try {
      await this.client.set(key, JSON.stringify(value), { EX: ttl });
      for (const tag of tags) {
        const tagSet = this.tagSetKey(tag);
        await this.client.sAdd(tagSet, key);
        // Tag set should never expire before its longest-lived member.
        await this.client.expire(tagSet, ttl);
      }
    } catch (err) {
      this.logger.warn(
        `Cache SET (tagged) failed for key "${key}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Delete every key registered under `tag`, then the tag set itself.
   * Targeted alternative to `delPattern` — only touches keys that were
   * actually written under this tag.
   */
  async invalidateTag(tag: string): Promise<void> {
    if (!this.client) return;
    try {
      const tagSet = this.tagSetKey(tag);
      const keys = await this.client.sMembers(tagSet);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
      await this.client.del(tagSet);
      this.logger.debug(
        `Invalidated ${keys.length} keys tagged "${tag}"`,
      );
    } catch (err) {
      this.logger.warn(
        `Cache tag invalidation failed for tag "${tag}": ${(err as Error).message}`,
      );
    }
  }

  /** Returns true when a live Redis connection is available. */
  get isConnected(): boolean {
    return this.client !== null && this.client.isOpen;
  }
}
