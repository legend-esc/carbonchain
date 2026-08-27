import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type Redis as RedisClient } from 'ioredis';

/**
 * TTL-based Redis cache service with Sentinel HA support.
 *
 * Connection modes (controlled by environment variables):
 *
 * 1. **Sentinel mode** (production / staging) — set `REDIS_SENTINEL_HOSTS` to a
 *    comma-separated list of `<host>:<port>` entries and `REDIS_SENTINEL_NAME` to
 *    the master name (defaults to `mymaster`).
 *
 *    ```env
 *    REDIS_SENTINEL_HOSTS=redis-sentinel-1:26379,redis-sentinel-2:26379,redis-sentinel-3:26379
 *    REDIS_SENTINEL_NAME=mymaster
 *    ```
 *
 *    ioredis Sentinel will automatically discover the current master, reconnect
 *    after failover, and retry commands — providing <5s downtime during a master
 *    promotion.
 *
 * 2. **Single-node mode** (local dev) — set `REDIS_URL` only (no sentinel hosts).
 *    Falls back to a no-op when `REDIS_URL` is also absent.
 *
 * Falls back to a no-op (in-memory disabled) mode when neither variable is set,
 * so the API starts cleanly in environments without Redis.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private client: RedisClient | null = null;
  private connected = false;
  private readonly defaultTtlSeconds: number;

  // Circuit breaker state for graceful degradation when Redis is unavailable.
  private readonly circuitBreaker = {
    failures: 0,
    lastFailureAt: 0,
    threshold: 5,
    windowMs: 5_000,
    open: false,
  };

  constructor(private readonly config: ConfigService) {
    this.defaultTtlSeconds = config.get<number>('CACHE_TTL_SECONDS', 60);
  }

  /** Connect to Redis (Sentinel or single-node). Called by CacheModule on bootstrap. */
  async connect(): Promise<void> {
    const sentinelHosts = this.config.get<string>('REDIS_SENTINEL_HOSTS');
    const sentinelName =
      this.config.get<string>('REDIS_SENTINEL_NAME') ?? 'mymaster';
    const redisUrl = this.config.get<string>('REDIS_URL');

    if (sentinelHosts) {
      // ── Sentinel mode ────────────────────────────────────────────────────
      const sentinels = sentinelHosts
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [host, portStr] = entry.split(':');
          return { host, port: parseInt(portStr ?? '26379', 10) };
        });

      this.logger.log(
        `Connecting to Redis via Sentinel (master: "${sentinelName}", sentinels: ${sentinelHosts})`,
      );

      try {
        this.client = new Redis({
          sentinels,
          name: sentinelName,
          // Retry indefinitely with exponential backoff (capped at 5s)
          retryStrategy: (times: number) => Math.min(times * 100, 5000),
          enableOfflineQueue: true,
          lazyConnect: false,
        });

        this.client.on('error', (err: Error) =>
          this.logger.error(`Redis Sentinel client error: ${err.message}`),
        );
        this.client.on('+failover-end', () =>
          this.logger.log(
            'Redis Sentinel: failover complete — new master elected',
          ),
        );
        this.client.on('ready', () =>
          this.logger.log(
            `Redis Sentinel connected to master "${sentinelName}"`,
          ),
        );

        // Wait for initial connection
        await this.client.ping();
        this.connected = true;
        this.resetCircuitBreaker();
        this.logger.log('Redis Sentinel connection established');
      } catch (err) {
        this.logger.error(
          `Failed to connect to Redis Sentinel: ${(err as Error).message}`,
        );
        this.client = null;
        this.connected = false;
      }
    } else if (redisUrl) {
      // ── Single-node mode ─────────────────────────────────────────────────
      this.logger.log(`Connecting to Redis at ${redisUrl}`);
      try {
        this.client = new Redis(redisUrl, {
          retryStrategy: (times: number) => Math.min(times * 100, 5000),
          enableOfflineQueue: true,
          lazyConnect: false,
        });

        this.client.on('error', (err: Error) =>
          this.logger.error(`Redis client error: ${err.message}`),
        );
        this.client.on('ready', () =>
          this.logger.log(`Redis connected at ${redisUrl}`),
        );

        await this.client.ping();
        this.connected = true;
        this.resetCircuitBreaker();
        this.logger.log(`Connected to Redis at ${redisUrl}`);
      } catch (err) {
        this.logger.error(
          `Failed to connect to Redis: ${(err as Error).message}`,
        );
        this.client = null;
        this.connected = false;
      }
    } else {
      this.logger.warn(
        'Neither REDIS_SENTINEL_HOSTS nor REDIS_URL is set — caching disabled (no-op fallback)',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
  }

  private recordFailure(): void {
    const now = Date.now();
    if (
      now - this.circuitBreaker.lastFailureAt >
      this.circuitBreaker.windowMs
    ) {
      this.circuitBreaker.failures = 1;
    } else {
      this.circuitBreaker.failures++;
    }
    this.circuitBreaker.lastFailureAt = now;
    if (this.circuitBreaker.failures > this.circuitBreaker.threshold) {
      this.circuitBreaker.open = true;
      this.logger.warn(
        `Redis circuit breaker opened after ${this.circuitBreaker.failures} failures within ${this.circuitBreaker.windowMs}ms — serving cache-miss`,
      );
    }
  }

  private resetCircuitBreaker(): void {
    this.circuitBreaker.failures = 0;
    this.circuitBreaker.lastFailureAt = 0;
    this.circuitBreaker.open = false;
  }

  private isCacheAvailable(): boolean {
    if (!this.client || !this.connected) {
      this.recordFailure();
      return false;
    }
    if (this.circuitBreaker.open) {
      return false;
    }
    return true;
  }

  /**
   * Retrieve a cached value. Returns `null` on cache miss or when Redis is unavailable.
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.isCacheAvailable()) return null;
    try {
      const raw = await this.client!.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(
        `Cache GET failed for key "${key}": ${(err as Error).message}`,
      );
      this.recordFailure();
      return null;
    }
  }

  /**
   * Store a value with an optional TTL (seconds). Defaults to CACHE_TTL_SECONDS env var.
   *
   * Returns `false` when the value could not be persisted (cache unavailable or
   * the write failed) so callers relying on the write for correctness (e.g.
   * token revocation) can fail closed instead of assuming success.
   */
  async set(
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<boolean> {
    if (!this.isCacheAvailable()) return false;
    try {
      const ttl = ttlSeconds ?? this.defaultTtlSeconds;
      await this.client!.set(key, JSON.stringify(value), 'EX', ttl);
      return true;
    } catch (err) {
      this.logger.warn(
        `Cache SET failed for key "${key}": ${(err as Error).message}`,
      );
      this.recordFailure();
      return false;
    }
  }

  /**
   * Delete one or more keys. Used for cache invalidation.
   */
  async del(...keys: string[]): Promise<void> {
    if (!this.isCacheAvailable() || keys.length === 0) return;
    try {
      await this.client!.del(keys);
    } catch (err) {
      this.logger.warn(
        `Cache DEL failed for keys [${keys.join(', ')}]: ${(err as Error).message}`,
      );
      this.recordFailure();
    }
  }

  /**
   * Delete all keys matching a glob pattern (e.g. `credits:*`).
   * Uses SCAN internally to avoid blocking the Redis event loop.
   *
   * Scans the whole keyspace via `KEYS` — O(n) in total key count and blocks
   * the event loop under load. Prefer `setTagged`/`invalidateTag` for cache
   * entries that need targeted invalidation.
   */
  async delPattern(pattern: string): Promise<void> {
    if (!this.isCacheAvailable()) return;
    try {
      const keys: string[] = [];
      let cursor: string = '0';
      do {
        const [nextCursor, matchedKeys] = await this.client!.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        keys.push(...matchedKeys);
      } while (cursor !== '0');

      if (keys.length > 0) {
        await this.client!.del(keys);
        this.logger.debug(
          `Invalidated ${keys.length} keys matching "${pattern}"`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Cache DEL pattern "${pattern}" failed: ${(err as Error).message}`,
      );
      this.recordFailure();
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
      await this.client.set(key, JSON.stringify(value), 'EX', ttl);
      for (const tag of tags) {
        const tagSet = this.tagSetKey(tag);
        await this.client.sadd(tagSet, key);
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
      const keys = await this.client.smembers(tagSet);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
      await this.client.del(tagSet);
      this.logger.debug(`Invalidated ${keys.length} keys tagged "${tag}"`);
    } catch (err) {
      this.logger.warn(
        `Cache tag invalidation failed for tag "${tag}": ${(err as Error).message}`,
      );
    }
  }

  /** Returns true when a live Redis connection is available and circuit breaker is closed. */
  get isConnected(): boolean {
    return this.isCacheAvailable();
  }
}
