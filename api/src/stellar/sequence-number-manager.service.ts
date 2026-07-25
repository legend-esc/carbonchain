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

  constructor(configService?: ConfigService) {
    const raw = configService?.get<string>('SEQ_CACHE_TTL_MS');
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    this.ttlMs = Number.isFinite(parsed) ? parsed : DEFAULT_SEQ_CACHE_TTL_MS;
  }

  /**
   * Returns the next sequence number for `publicKey` if a non-expired entry
   * exists in the cache, incrementing the stored value optimistically.
   * Returns `undefined` when the cache is cold or the entry has expired.
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
