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
  private readonly defaultTtlSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.defaultTtlSeconds = config.get<number>('CACHE_TTL_SECONDS', 60);
  }

  /** Connect to Redis (Sentinel or single-node). Called by CacheModule on bootstrap. */
  async connect(): Promise<void> {
    const sentinelHosts = this.config.get<string>('REDIS_SENTINEL_HOSTS');
    const sentinelName = this.config.get<string>('REDIS_SENTINEL_NAME') ?? 'mymaster';
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
          this.logger.log('Redis Sentinel: failover complete — new master elected'),
        );
        this.client.on('ready', () =>
          this.logger.log(`Redis Sentinel connected to master "${sentinelName}"`),
        );

        // Wait for initial connection
        await this.client.ping();
        this.logger.log('Redis Sentinel connection established');
      } catch (err) {
        this.logger.error(
          `Failed to connect to Redis Sentinel: ${(err as Error).message}`,
        );
        this.client = null;
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
        this.logger.log(`Connected to Redis at ${redisUrl}`);
      } catch (err) {
        this.logger.error(
          `Failed to connect to Redis: ${(err as Error).message}`,
        );
        this.client = null;
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
      await this.client.set(key, JSON.stringify(value), 'EX', ttl);
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
      await this.client.del(...keys);
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
        await this.client.del(...keys);
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
    return this.client !== null && this.client.status === 'ready';
  }
}
