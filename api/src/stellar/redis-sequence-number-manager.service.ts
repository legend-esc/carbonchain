import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../common/cache.service';
import { SequenceNumberManager } from './sequence-number-manager.service';

/**
 * Redis key prefix for per-account sequence number storage.
 * Full key pattern: stellar:seq:<publicKey>
 */
const SEQ_KEY = (pk: string) => `stellar:seq:${pk}`;

/**
 * Redis key prefix for the per-account distributed lock (SETNX lease).
 * Full key pattern: stellar:seq:lock:<publicKey>
 */
const LOCK_KEY = (pk: string) => `stellar:seq:lock:${pk}`;

/**
 * Default TTL for the distributed lock (ms).
 * If a process holds the lock and crashes, the lock auto-expires after this
 * interval so other replicas are not blocked indefinitely.
 */
const DEFAULT_LOCK_TTL_MS = 5_000;

/**
 * Polling interval when waiting to acquire a lock held by another replica.
 */
const LOCK_POLL_INTERVAL_MS = 50;

/**
 * Maximum time (ms) to wait for a lock before falling back to Horizon fetch.
 */
const MAX_LOCK_WAIT_MS = 4_000;

/**
 * Issue #914 — Redis-backed sequence number manager for multi-replica deployments.
 *
 * ## Distributed lock + INCR strategy
 *
 * To guarantee that two replicas never use the same sequence number for the
 * same Stellar account, this implementation follows the pattern documented in
 * the TODO comment inside SequenceNumberManager:
 *
 *   1. Attempt to acquire a per-account lock via Redis `SET NX PX <ttl>`.
 *   2. If the lock is acquired:
 *        a. If no cached sequence exists (cache cold), fetch the current
 *           account sequence from Horizon and seed the counter.
 *        b. Atomically increment the counter via `INCR` and return the
 *           pre-increment value as the next sequence to use.
 *        c. Release the lock immediately after the INCR.
 *   3. If the lock is already held by another replica, poll until it is
 *      released (or `MAX_LOCK_WAIT_MS` elapses), then retry.
 *
 * ## Fallback
 *
 * If Redis is unavailable (CacheService.isConnected === false), the manager
 * falls back to the in-memory SequenceNumberManager transparently.  This
 * ensures single-pod / test environments continue working without Redis.  A
 * warning is logged every time the fallback is engaged so operators can detect
 * persistent Redis connectivity issues.
 *
 * ## Environment variables
 *
 * - `SEQ_CACHE_TTL_MS` (optional, default 60 000) — TTL applied to the Redis
 *   sequence counter key.  When the key expires the next call re-seeds from
 *   Horizon, preventing indefinitely-stale counters.
 */
@Injectable()
export class RedisSequenceNumberManager {
  private readonly logger = new Logger(RedisSequenceNumberManager.name);
  private readonly seqTtlMs: number;
  private readonly lockTtlMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
    private readonly inMemoryFallback: SequenceNumberManager,
  ) {
    const rawTtl = configService.get<string>('SEQ_CACHE_TTL_MS');
    const parsedTtl = rawTtl !== undefined ? parseInt(rawTtl, 10) : NaN;
    this.seqTtlMs = Number.isFinite(parsedTtl) ? parsedTtl : 60_000;

    this.lockTtlMs = DEFAULT_LOCK_TTL_MS;
  }

  /**
   * Returns the next sequence number for `publicKey`, guaranteed to be unique
   * across all replicas that share the same Redis instance.
   *
   * If Redis is unavailable, falls back to the in-memory SequenceNumberManager
   * with a warning log so that single-pod / CI environments continue working.
   *
   * @param publicKey  Stellar account public key.
   * @param fetchFn    Async function that fetches the current sequence from Horizon
   *                   when the Redis cache is cold.
   */
  async getNextSequenceNumberAtomic(
    publicKey: string,
    fetchFn: () => Promise<number>,
  ): Promise<number> {
    if (!this.cacheService.isConnected) {
      this.logger.warn(
        `[#914] Redis unavailable — falling back to in-memory sequence manager for ${publicKey}`,
      );
      return this.inMemoryFallback.getNextSequenceNumberAtomic(
        publicKey,
        fetchFn,
      );
    }

    const lockKey = LOCK_KEY(publicKey);
    const seqKey = SEQ_KEY(publicKey);

    // Acquire the distributed lock.
    const lockAcquired = await this.acquireLock(lockKey, publicKey);
    if (!lockAcquired) {
      // Could not acquire lock within MAX_LOCK_WAIT_MS — degrade gracefully.
      this.logger.warn(
        `[#914] Could not acquire Redis lock for ${publicKey} within ${MAX_LOCK_WAIT_MS}ms — falling back to in-memory`,
      );
      return this.inMemoryFallback.getNextSequenceNumberAtomic(
        publicKey,
        fetchFn,
      );
    }

    try {
      // Check whether a sequence counter already exists in Redis.
      const client = this.getRedisClient();
      if (!client) {
        return this.inMemoryFallback.getNextSequenceNumberAtomic(
          publicKey,
          fetchFn,
        );
      }

      const existingRaw = await client.get(seqKey);

      if (existingRaw === null) {
        // Cache cold — seed from Horizon.
        const horizonSeq = await fetchFn();
        // Store the base sequence; INCR will return horizonSeq + 1 (the next to use).
        // We store horizonSeq directly; the first INCR yields horizonSeq + 1 which is
        // the correct next sequence number (Stellar uses the sequence as the *base*
        // and the submitted tx must have seq = account.sequence + 1).
        await client.set(
          seqKey,
          String(horizonSeq),
          'PX',
          this.seqTtlMs,
        );
        this.logger.debug(
          `[#914] Seeded Redis sequence for ${publicKey}: ${horizonSeq}`,
        );
      }

      // Atomic increment — returns the new value (i.e., next sequence number to use).
      const nextSeq = await client.incr(seqKey);
      // Refresh TTL after each use so active accounts don't expire mid-burst.
      await client.pexpire(seqKey, this.seqTtlMs);

      this.logger.debug(
        `[#914] Redis INCR sequence for ${publicKey}: ${nextSeq}`,
      );
      return nextSeq;
    } finally {
      // Always release the lock immediately after the INCR so other replicas
      // are unblocked as quickly as possible.
      await this.releaseLock(lockKey);
    }
  }

  /**
   * Store an externally-known sequence number for `publicKey` in Redis.
   * Used to seed or correct the counter after a Horizon fetch.
   */
  async cacheSequenceNumber(publicKey: string, seq: number): Promise<void> {
    if (!this.cacheService.isConnected) {
      this.inMemoryFallback.cacheSequenceNumber(publicKey, seq);
      return;
    }

    const client = this.getRedisClient();
    if (!client) {
      this.inMemoryFallback.cacheSequenceNumber(publicKey, seq);
      return;
    }

    await client.set(SEQ_KEY(publicKey), String(seq), 'PX', this.seqTtlMs);
    this.logger.debug(
      `[#914] Cached sequence for ${publicKey}: ${seq} (TTL ${this.seqTtlMs}ms)`,
    );
  }

  /**
   * Evict the sequence counter for `publicKey` from Redis and in-memory fallback,
   * forcing a fresh Horizon fetch on the next call.
   */
  async reset(publicKey: string): Promise<void> {
    this.inMemoryFallback.reset(publicKey);

    if (!this.cacheService.isConnected) return;

    const client = this.getRedisClient();
    if (!client) return;

    await client.del(SEQ_KEY(publicKey));
    this.logger.debug(`[#914] Reset Redis sequence cache for ${publicKey}`);
  }

  /** Evict all sequence counters. Used in tests and emergency reset scenarios. */
  async clear(): Promise<void> {
    this.inMemoryFallback.clear();

    if (!this.cacheService.isConnected) return;

    const client = this.getRedisClient();
    if (!client) return;

    // Scan for and delete all stellar:seq:* keys (excluding lock keys).
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH',
        'stellar:seq:[^l]*',
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await client.del(keys);
      }
    } while (cursor !== '0');

    this.logger.debug('[#914] Cleared all Redis sequence cache entries');
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Attempt to acquire the distributed lock for `lockKey` via `SET NX PX`.
   * Polls every LOCK_POLL_INTERVAL_MS until the lock is acquired or
   * MAX_LOCK_WAIT_MS elapses.
   *
   * @returns true when the lock was acquired, false when the timeout was hit.
   */
  private async acquireLock(
    lockKey: string,
    publicKey: string,
  ): Promise<boolean> {
    const client = this.getRedisClient();
    if (!client) return false;

    const deadline = Date.now() + MAX_LOCK_WAIT_MS;
    const lockValue = `${process.pid}-${Date.now()}`;

    while (Date.now() < deadline) {
      // SET NX PX — only sets when the key does not exist.
      const result = await client.set(
        lockKey,
        lockValue,
        'NX',
        'PX',
        this.lockTtlMs,
      );

      if (result === 'OK') {
        return true;
      }

      // Lock held by another replica — wait briefly before retrying.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, LOCK_POLL_INTERVAL_MS),
      );
    }

    this.logger.warn(
      `[#914] Lock acquisition timeout for ${publicKey} after ${MAX_LOCK_WAIT_MS}ms`,
    );
    return false;
  }

  /** Release the distributed lock by deleting it from Redis. */
  private async releaseLock(lockKey: string): Promise<void> {
    const client = this.getRedisClient();
    if (!client) return;

    await client.del(lockKey);
  }

  /**
   * Access the raw ioredis client via CacheService's internal `client` field.
   * We use a bracket accessor with an `any` cast because CacheService does not
   * expose its client via a public API — keeping this adapter self-contained.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getRedisClient(): any {
    // CacheService stores its ioredis client as a private field `client`.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    return (this.cacheService as any)['client'] ?? null;
  }
}
