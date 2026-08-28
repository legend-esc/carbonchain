import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Default TTL for cached sequence numbers in milliseconds (60 seconds).
 * Configurable via SEQ_CACHE_TTL_MS environment variable.
 */
const DEFAULT_SEQ_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: number;
  expiresAt: number;
}

/**
 * Manages in-process sequence number caching with TTL eviction.
 *
 * Issue #473: Previously entries lived forever, causing stale sequence numbers
 * when another process submitted a transaction from the same account.
 *
 * Fix:
 * - Each entry carries an `expiresAt` timestamp (Date.now() + TTL).
 * - `getNextSequenceNumber` returns `undefined` for expired entries, forcing a
 *   fresh Horizon fetch.
 * - `cacheSequenceNumber` always sets a fresh TTL.
 * - TTL is configurable via the `SEQ_CACHE_TTL_MS` environment variable
 *   (default 60 000 ms).
 *
 * Issue #510: Race condition under concurrent transaction submission.
 *
 * Problem: Node.js is single-threaded but async handlers can interleave.
 * When two concurrent `invokeContract` calls arrive for the same account:
 *   1. Both call `getNextSequenceNumber` → both see cached value N.
 *   2. Both set cache to N+1.
 *   3. Both build transactions with sequence N — one will fail with tx_bad_seq.
 *
 * Fix: Per-account promise queue (mutex pattern without external dependencies).
 * `getNextSequenceNumberAtomic` enqueues all callers for the same account so
 * only one runs at a time. Each caller gets a unique, monotonically increasing
 * sequence number.
 *
 * Multi-instance note: In a multi-instance deployment sequence coordination
 * requires an atomic INCR on a shared store (e.g. Redis). The recommended
 * pattern is:
 *   1. SETNX  stellar:seq:<pk>  <horizon_seq>  EX 60
 *   2. INCR   stellar:seq:<pk>              (atomic, returns next seq)
 * This ensures no two instances use the same sequence number. This class is
 * the single-instance implementation; a Redis-backed variant should wrap the
 * same interface using ioredis `multi().incr().exec()`.
 *
 * TODO(multi-instance): Replace with RedisSequenceNumberManager that wraps
 * ioredis and uses atomic INCR for multi-pod deployments.
 */
@Injectable()
export class SequenceNumberManager {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  /**
   * Per-account promise queue (Issue #510).
   * Each entry is the tail of the promise chain for that account.
   * Appending `.then(fn)` to the tail ensures fn runs after all previously
   * queued operations for the same account complete.
   */
  private readonly lockQueue = new Map<string, Promise<void>>();

  constructor(configService?: ConfigService) {
    const raw = configService?.get<string>('SEQ_CACHE_TTL_MS');
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    this.ttlMs = Number.isFinite(parsed) ? parsed : DEFAULT_SEQ_CACHE_TTL_MS;
  }

  /**
   * Returns the next sequence number for `publicKey` if a non-expired entry
   * exists in the cache, incrementing the stored value optimistically.
   * Returns `undefined` when the cache is cold or the entry has expired.
   *
   * ⚠️  This method is NOT concurrency-safe for async callers.
   * Use `getNextSequenceNumberAtomic` when multiple async paths may call this
   * for the same account simultaneously (e.g. concurrent HTTP request handlers).
   */
  getNextSequenceNumber(publicKey: string): number | undefined {
    const entry = this.cache.get(publicKey);
    if (entry === undefined) {
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      // TTL expired — evict and signal a Horizon fetch is needed.
      this.cache.delete(publicKey);
      return undefined;
    }
    const current = entry.value;
    // Optimistic increment: extend TTL on each use to avoid expiry mid-burst.
    this.cache.set(publicKey, {
      value: current + 1,
      expiresAt: Date.now() + this.ttlMs,
    });
    return current;
  }

  /**
   * Issue #510: Concurrency-safe variant of `getNextSequenceNumber`.
   *
   * Serialises all callers for the same `publicKey` through a promise queue so
   * that each async call receives a unique sequence number even when multiple
   * requests arrive simultaneously.
   *
   * If the cache is cold (no entry for `publicKey`), `fetchFn` is invoked to
   * get the current on-chain sequence number from Horizon.  The result is
   * cached and `fetchFn` will NOT be called again until the TTL expires.
   *
   * @param publicKey  The Stellar public key whose sequence number is needed.
   * @param fetchFn    Async function that fetches the current sequence number
   *                   from Horizon when the cache is cold or expired.
   * @returns          The next sequence number to use for this account.
   */
  async getNextSequenceNumberAtomic(
    publicKey: string,
    fetchFn: () => Promise<number>,
  ): Promise<number> {
    // Retrieve (or initialise) the tail of this account's promise queue.
    const tail = this.lockQueue.get(publicKey) ?? Promise.resolve();

    let resolve!: () => void;
    const next = new Promise<void>((res) => {
      resolve = res;
    });

    // Register this call as the new tail *before* awaiting so subsequent
    // callers always chain after us.
    this.lockQueue.set(publicKey, next);

    // Wait for all previously enqueued operations for this account to finish.
    await tail;

    try {
      let seq = this.getNextSequenceNumber(publicKey);
      if (seq === undefined) {
        // Cache miss or TTL expired — fetch from Horizon.
        const fetched = await fetchFn();
        this.cacheSequenceNumber(publicKey, fetched);
        seq = this.getNextSequenceNumber(publicKey)!;
      }
      return seq;
    } finally {
      // Release the lock so the next waiter can proceed.
      resolve();
      // Clean up the queue entry once this is the sole remaining promise.
      // This prevents unbounded Map growth; the next enqueuer will re-create it.
      if (this.lockQueue.get(publicKey) === next) {
        this.lockQueue.delete(publicKey);
      }
    }
  }

  /**
   * Stores `seq` as the next sequence number to hand out for `publicKey`.
   * Resets the TTL to a fresh window.
   */
  cacheSequenceNumber(publicKey: string, seq: number): void {
    this.cache.set(publicKey, {
      value: seq,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Evict the entry for `publicKey`, forcing a Horizon fetch on the next call. */
  reset(publicKey: string): void {
    this.cache.delete(publicKey);
  }

  /** Evict all entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of currently cached keys (including potentially expired ones not yet evicted). */
  count(): number {
    return this.cache.size;
  }

  /** Exposed for testing: returns the configured TTL in milliseconds. */
  getTtlMs(): number {
    return this.ttlMs;
  }
}
