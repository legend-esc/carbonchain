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
      this.client.on('error', (err: Error) => {
        this.logger.error(`Redis client error: ${err.message}`);
        this.recordFailure();
      });
      await this.client.connect();
      this.logger.log(`Connected to Redis at ${url}`);
      this.resetCircuitBreaker();
    } catch (err) {
      this.logger.error(
        `Failed to connect to Redis: ${(err as Error).message}`,
      );
      this.client = null;
      this.recordFailure();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
  }

  private recordFailure(): void {
    const now = Date.now();
    if (now - this.circuitBreaker.lastFailureAt > this.circuitBreaker.windowMs) {
      this.circuitBreaker.failures = 1;
    } else {
      this.circuitBreaker.failures++;
    }
    this.circuitBreaker.lastFailureAt = now;
    if (this.circuitBreaker.failures >= this.circuitBreaker.threshold) {
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
    if (!this.client || !this.client.isOpen) {
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
   */
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.isCacheAvailable()) return;
    try {
      const ttl = ttlSeconds ?? this.defaultTtlSeconds;
      await this.client!.set(key, JSON.stringify(value), { EX: ttl });
    } catch (err) {
      this.logger.warn(
        `Cache SET failed for key "${key}": ${(err as Error).message}`,
      );
      this.recordFailure();
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
   */
  async delPattern(pattern: string): Promise<void> {
    if (!this.isCacheAvailable()) return;
    try {
      const keys: string[] = [];
      let cursor: string = '0';
      do {
        const result = await this.client!.scan(cursor, {
          MATCH: pattern,
          COUNT: 100,
        });
        cursor = result.cursor;
        keys.push(...result.keys);
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

  /** Returns true when a live Redis connection is available and circuit breaker is closed. */
  get isConnected(): boolean {
    return this.isCacheAvailable();
  }
}
