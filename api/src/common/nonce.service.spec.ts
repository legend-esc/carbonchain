/**
 * #415 — NonceService unit tests
 *
 * Validates:
 *  • Atomic SET NX logic — first call succeeds, second throws 409
 *  • Graceful degradation when Redis is unavailable
 *  • Concurrent-request race: only one of N parallel calls succeeds
 *  • Key scheme: nonce:{address}:{nonce}
 */
import { ConflictException } from '@nestjs/common';
import { NonceService, nonceKey, NONCE_TTL_SECONDS } from './nonce.service';

// ── Mock Redis client ─────────────────────────────────────────────────────────

type SetOptions = { NX?: boolean; EX?: number };

/** In-memory Redis stub that implements SET NX + auto-expiry. */
class MockRedisClient {
  private store = new Map<string, number>(); // key → expiry epoch (ms)
  public calls: Array<{ key: string; options: SetOptions }> = [];

  /** Returns 'OK' on first write, null on subsequent writes (NX). */
  async set(
    key: string,
    _value: string,
    options: SetOptions = {},
  ): Promise<'OK' | null> {
    this.calls.push({ key, options });

    // Expire stale keys
    const now = Date.now();
    for (const [k, exp] of this.store) {
      if (exp <= now) this.store.delete(k);
    }

    if (options.NX && this.store.has(key)) {
      return null; // key exists — NX prevents overwrite
    }

    const ttlMs = (options.EX ?? 0) * 1000;
    this.store.set(key, now + ttlMs);
    return 'OK';
  }

  async quit() {}
  isOpen = true;
}

// ── Helper to build a wired-up NonceService with a mock Redis ─────────────────

function buildService(
  redis: MockRedisClient | null = new MockRedisClient(),
): NonceService {
  const config: any = {
    get: (key: string, def?: unknown) =>
      key === 'REDIS_URL' ? 'redis://localhost:6379' : def,
  };
  const svc = new NonceService(config);
  // Directly inject the mock so we don't need a real Redis server
  (svc as any).client = redis;
  (svc as any).connected = redis !== null;
  return svc;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NonceService — key scheme', () => {
  it('generates the expected Redis key', () => {
    expect(nonceKey('GADDR', '42')).toBe('nonce:GADDR:42');
  });

  it('handles BigInt nonce in key', () => {
    expect(nonceKey('GADDR', BigInt(7))).toBe('nonce:GADDR:7');
  });
});

describe('NonceService — atomic SET NX', () => {
  it('allows the first submission for a new nonce', async () => {
    const svc = buildService();
    await expect(svc.consumeNonce('GADDR', '1')).resolves.toBeUndefined();
  });

  it('throws 409 ConflictException on duplicate nonce within TTL window', async () => {
    const svc = buildService();
    await svc.consumeNonce('GADDR', '1'); // first — OK
    await expect(svc.consumeNonce('GADDR', '1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('allows the same nonce for a different address', async () => {
    const svc = buildService();
    await svc.consumeNonce('GADDR1', '1');
    await expect(svc.consumeNonce('GADDR2', '1')).resolves.toBeUndefined();
  });

  it('uses the correct key for SET NX', async () => {
    const redis = new MockRedisClient();
    const svc = buildService(redis);
    await svc.consumeNonce('GADDR', '99');
    expect(redis.calls[0].key).toBe('nonce:GADDR:99');
    expect(redis.calls[0].options.NX).toBe(true);
    expect(redis.calls[0].options.EX).toBe(NONCE_TTL_SECONDS);
  });
});

describe('NonceService — concurrent request race (#415)', () => {
  it('allows exactly one winner out of N concurrent requests with the same nonce', async () => {
    // Serialised mock: counts how many concurrent SET NX calls arrive before any resolves.
    // We use a real sequential MockRedisClient; JavaScript's event loop serialises the
    // async calls, so the first `.set` that touches the Map wins.
    const svc = buildService();

    const CONCURRENCY = 10;
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        svc.consumeNonce('GADDR', '42'),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one call should succeed
    expect(fulfilled).toHaveLength(1);
    // All remaining N-1 calls should fail with 409
    expect(rejected).toHaveLength(CONCURRENCY - 1);

    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );
    }
  });
});

describe('NonceService — graceful degradation', () => {
  it('does not throw when Redis is unavailable', async () => {
    const svc = buildService(null); // no Redis client
    await expect(svc.consumeNonce('GADDR', '1')).resolves.toBeUndefined();
  });

  it('reports isConnected = false when client is null', () => {
    const svc = buildService(null);
    expect(svc.isConnected).toBe(false);
  });

  it('reports isConnected = true when client is available', () => {
    const svc = buildService(new MockRedisClient());
    expect(svc.isConnected).toBe(true);
  });
});
