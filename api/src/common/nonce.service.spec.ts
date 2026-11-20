/**
 * #415 / #938 — NonceService unit tests
 *
 * Validates:
 *  • Atomic SET NX logic — first call succeeds, second throws 409
 *  • Concurrent-request race: only one of N parallel calls succeeds
 *  • Key scheme: nonce:{address}:{nonce}
 *  • #938: Redis-down path — throws NonceDegradedException (503)
 *  • #938: Circuit transitions: up → degraded → up on heal
 *  • #938: Circuit transitions: up → down when connect fails
 *  • #938: circuitStateChanges metric increments on each transition
 *  • #938: Clock-skew / TTL boundary — two claims within TTL, expiry mid-flight
 *  • #938: degraded state throws distinct nonce_service_degraded error
 */
import { ConflictException } from '@nestjs/common';
import {
  NonceService,
  NonceDegradedException,
  nonceKey,
  NONCE_TTL_SECONDS,
  RECONNECT_PROBE_INTERVAL_MS,
} from './nonce.service';

// ── Mock Redis client ─────────────────────────────────────────────────────────

/**
 * In-memory Redis stub that implements SET NX + auto-expiry.
 * Supports optional failure injection via `failNextSet`.
 */
class MockRedisClient {
  private store = new Map<string, number>(); // key → expiry epoch (ms)
  public calls: Array<{ key: string; args: Array<string | number> }> = [];
  /** When set to an Error, the next set() call throws it then clears the flag. */
  public failNextSet: Error | null = null;

  /** Override Date.now for clock-skew tests. */
  public nowMs: () => number = () => Date.now();

  async set(
    key: string,
    _value: string,
    ...args: Array<string | number>
  ): Promise<'OK' | null> {
    this.calls.push({ key, args });

    if (this.failNextSet) {
      const err = this.failNextSet;
      this.failNextSet = null;
      throw err;
    }

    const now = this.nowMs();
    // Expire stale keys
    for (const [k, exp] of this.store) {
      if (exp <= now) this.store.delete(k);
    }

    if (args.includes('NX') && this.store.has(key)) {
      return null; // NX — key exists, refuse overwrite
    }

    const exIdx = args.indexOf('EX');
    const ttlMs = (exIdx !== -1 ? Number(args[exIdx + 1]) : 0) * 1000;
    this.store.set(key, now + ttlMs);
    return 'OK';
  }

  async quit() {}

  /** Simulate a key expiring at a specific future timestamp. */
  expireAt(key: string, atMs: number): void {
    this.store.set(key, atMs);
  }

  /** Manually expire a key (simulate TTL elapsing). */
  expireKey(key: string): void {
    this.store.delete(key);
  }
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
  // Directly inject the mock so we don't need a real Redis server.
  (svc as any).client = redis;
  (svc as any).connected = redis !== null;
  // Start circuit in 'up' if redis is healthy, 'down' if null.
  (svc as any)._circuitState = redis !== null ? 'up' : 'down';
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
    expect(redis.calls[0].args).toContain('NX');
    expect(redis.calls[0].args).toContain('EX');
    expect(redis.calls[0].args).toContain(NONCE_TTL_SECONDS);
  });
});

describe('NonceService — concurrent request race (#415)', () => {
  it('allows exactly one winner out of N concurrent requests with the same nonce', async () => {
    const svc = buildService();
    const CONCURRENCY = 10;
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        svc.consumeNonce('GADDR', '42'),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENCY - 1);

    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConflictException);
    }
  });
});

// ── #938: Redis-down / circuit-breaker tests ──────────────────────────────────

describe('NonceService — #938 Redis-down: throws NonceDegradedException', () => {
  it('throws NonceDegradedException (503) when Redis client is null (no connection)', async () => {
    const svc = buildService(null);
    await expect(svc.consumeNonce('GADDR', '1')).rejects.toBeInstanceOf(
      NonceDegradedException,
    );
  });

  it('NonceDegradedException has error code nonce_service_degraded', async () => {
    const svc = buildService(null);
    try {
      await svc.consumeNonce('GADDR', '1');
      fail('Expected NonceDegradedException');
    } catch (err) {
      expect(err).toBeInstanceOf(NonceDegradedException);
      const response = (err as NonceDegradedException).getResponse() as any;
      expect(response.error).toBe('nonce_service_degraded');
    }
  });

  it('two concurrent claims when Redis is down both throw NonceDegradedException', async () => {
    const svc = buildService(null);
    const [r1, r2] = await Promise.allSettled([
      svc.consumeNonce('GADDR', '1'),
      svc.consumeNonce('GADDR', '2'),
    ]);
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    if (r1.status === 'rejected')
      expect(r1.reason).toBeInstanceOf(NonceDegradedException);
    if (r2.status === 'rejected')
      expect(r2.reason).toBeInstanceOf(NonceDegradedException);
  });

  it('throws NonceDegradedException when SET NX itself throws a connectivity error', async () => {
    const redis = new MockRedisClient();
    const svc = buildService(redis);

    // Inject a connectivity failure for the next SET NX call.
    redis.failNextSet = new Error('ECONNRESET');

    await expect(svc.consumeNonce('GADDR', '1')).rejects.toBeInstanceOf(
      NonceDegradedException,
    );
  });
});

describe('NonceService — #938 circuit state transitions', () => {
  it('starts in "up" state when Redis is healthy', () => {
    const svc = buildService(new MockRedisClient());
    expect(svc.circuitState).toBe('up');
  });

  it('starts in "down" state when Redis client is null', () => {
    const svc = buildService(null);
    expect(svc.circuitState).toBe('down');
  });

  it('transitions to "degraded" when SET NX encounters a connectivity error', async () => {
    const redis = new MockRedisClient();
    const svc = buildService(redis);
    expect(svc.circuitState).toBe('up');

    redis.failNextSet = new Error('ECONNRESET');
    await expect(svc.consumeNonce('GADDR', '1')).rejects.toBeInstanceOf(
      NonceDegradedException,
    );

    expect(svc.circuitState).toBe('degraded');
  });

  it('heals from "degraded" to "up" on a successful SET NX', async () => {
    const redis = new MockRedisClient();
    const svc = buildService(redis);

    // Force into degraded
    redis.failNextSet = new Error('ECONNRESET');
    await expect(svc.consumeNonce('GADDR', '1')).rejects.toBeDefined();
    expect(svc.circuitState).toBe('degraded');

    // Next successful call should heal
    await svc.consumeNonce('GADDR', '2');
    expect(svc.circuitState).toBe('up');
  });

  it('increments circuitStateChanges on each transition', async () => {
    const redis = new MockRedisClient();
    const svc = buildService(redis);
    const initial = svc.circuitStateChanges;

    // up → degraded (1 transition)
    redis.failNextSet = new Error('ECONNRESET');
    await expect(svc.consumeNonce('GADDR', '1')).rejects.toBeDefined();
    expect(svc.circuitStateChanges).toBe(initial + 1);

    // degraded → up (1 more transition)
    await svc.consumeNonce('GADDR', '2');
    expect(svc.circuitStateChanges).toBe(initial + 2);
  });

  it('stays in "degraded" without double-counting if already degraded', async () => {
    const redis = new MockRedisClient();
    const svc = buildService(redis);

    // Force into degraded via first error
    redis.failNextSet = new Error('ECONNRESET');
    await expect(svc.consumeNonce('GADDR', '1')).rejects.toBeDefined();
    const afterFirst = svc.circuitStateChanges;

    // Second error while already degraded → no additional state change
    redis.failNextSet = new Error('ECONNRESET');
    await expect(svc.consumeNonce('GADDR', '2')).rejects.toBeDefined();
    expect(svc.circuitStateChanges).toBe(afterFirst); // no extra transition
  });
});

describe('NonceService — #938 clock-skew / TTL boundary', () => {
  it('allows two distinct nonces within the same TTL window', async () => {
    const svc = buildService();
    await svc.consumeNonce('GADDR', '100');
    await expect(svc.consumeNonce('GADDR', '101')).resolves.toBeUndefined();
  });

  it('allows the same nonce to be reused after TTL expires', async () => {
    const redis = new MockRedisClient();
    const svc = buildService(redis);

    // Claim nonce 1
    await svc.consumeNonce('GADDR', '1');

    // Simulate TTL expiry by removing the key from the mock store.
    const key = nonceKey('GADDR', '1');
    redis.expireKey(key);

    // After expiry the same nonce should be claimable again.
    await expect(svc.consumeNonce('GADDR', '1')).resolves.toBeUndefined();
  });

  it('second claim on the same nonce before TTL expires is rejected (no clock skew)', async () => {
    const svc = buildService();
    await svc.consumeNonce('GADDR', '42');
    await expect(svc.consumeNonce('GADDR', '42')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('expiry mid-flight: claim before expiry succeeds, claim after expiry of same nonce also succeeds', async () => {
    const redis = new MockRedisClient();
    const svc = buildService(redis);

    // T=0: claim succeeds
    await svc.consumeNonce('GADDR', '77');

    // T=TTL+1: simulate expiry by removing key
    redis.expireKey(nonceKey('GADDR', '77'));

    // T=TTL+2: same nonce should be accepted again (key expired)
    await expect(svc.consumeNonce('GADDR', '77')).resolves.toBeUndefined();
  });
});

describe('NonceService — isConnected and state accessors', () => {
  it('reports isConnected = false when client is null', () => {
    const svc = buildService(null);
    expect(svc.isConnected).toBe(false);
  });

  it('reports isConnected = true when client is available', () => {
    const svc = buildService(new MockRedisClient());
    expect(svc.isConnected).toBe(true);
  });
});

describe('NonceService — RECONNECT_PROBE_INTERVAL_MS constant', () => {
  it('is a positive number', () => {
    expect(RECONNECT_PROBE_INTERVAL_MS).toBeGreaterThan(0);
  });
});
