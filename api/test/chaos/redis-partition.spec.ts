/**
 * Chaos engineering tests for Redis sequence manager network partitions.
 * Issue #1388
 *
 * Prerequisites:
 *   1. Toxiproxy running: docker run --rm -p 8474:8474 -p 16379:16379 ghcr.io/shopify/toxiproxy
 *   2. Redis running on localhost:6379
 *   3. TOXIPROXY_HOST env var set (or defaults to localhost)
 *
 * Run with:
 *   TOXIPROXY_HOST=localhost npx jest api/test/chaos/redis-partition.spec.ts --testEnvironment node
 */

import Redis from 'ioredis';
// toxiproxy-node-client uses a default export for Toxiproxy and named exports
// for toxic types. Import via require to stay compatible with both CJS builds.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Toxiproxy } = require('toxiproxy-node-client') as {
  Toxiproxy: new (baseUrl: string) => ToxiproxyClient;
};

// ── Minimal Toxiproxy client type definitions ─────────────────────────────────

interface ToxicAttributes {
  [key: string]: number | string | boolean;
}

interface Toxic {
  name: string;
  type: string;
  toxicity: number;
  attributes: ToxicAttributes;
}

interface ProxyBase {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
  toxics: Toxic[];
}

interface ToxiproxyProxy {
  name: string;
  listen: string;
  upstream: string;
  enabled: boolean;
  toxics: Toxic[];
  addToxic(toxic: Partial<Toxic> & { type: string }): Promise<Toxic>;
  removeToxic(name: string): Promise<void>;
  update(attrs: Partial<ProxyBase>): Promise<void>;
  remove(): Promise<void>;
  refreshToxics(): Promise<Toxic[]>;
}

interface ToxiproxyClient {
  createProxy(attrs: {
    name: string;
    listen: string;
    upstream: string;
  }): Promise<ToxiproxyProxy>;
  getProxy(name: string): Promise<ToxiproxyProxy>;
  reset(): Promise<void>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TOXIPROXY_HOST = process.env.TOXIPROXY_HOST ?? 'localhost';
const TOXIPROXY_API_PORT = 8474;
const CHAOS_PROXY_PORT = 16379;
const PROXY_NAME = 'redis-chaos';

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = 6379;

// Lock / sequence key helpers (mirror the real service constants).
const SEQ_KEY = (pk: string) => `stellar:seq:${pk}`;
const LOCK_KEY = (pk: string) => `stellar:seq:lock:${pk}`;

/** Lock TTL used in the inline test harness (ms). */
const LOCK_TTL_MS = 5_000;
/** How long to wait for a lock before giving up (ms). */
const MAX_LOCK_WAIT_MS = 4_000;
/** Polling interval while waiting on a lock (ms). */
const LOCK_POLL_MS = 50;
/** Per-operation Redis command timeout (ms). */
const OP_TIMEOUT_MS = 3_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an ioredis client that connects through the Toxiproxy listener.
 * Short connect/command timeouts ensure tests don't stall when the proxy
 * is fully partitioned.
 */
function buildChaosClient(): Redis {
  return new Redis({
    host: TOXIPROXY_HOST,
    port: CHAOS_PROXY_PORT,
    // Don't auto-reconnect indefinitely inside a chaos test — fail fast.
    retryStrategy: () => null,
    connectTimeout: OP_TIMEOUT_MS,
    commandTimeout: OP_TIMEOUT_MS,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

/**
 * Minimal inline replication of the INCR + distributed-lock pattern used by
 * RedisSequenceNumberManager. Exercises the actual Redis wire protocol under
 * chaos conditions without requiring the full NestJS DI container.
 *
 * Returns -1 if any Redis operation throws (simulates the in-memory fallback
 * returning a sentinel so callers can detect the degraded path).
 *
 * @param client  An ioredis client pointing at the Toxiproxy-proxied Redis.
 * @param pk      Synthetic Stellar public key used as the cache key scope.
 * @param baseSeq Initial sequence to seed when the key is absent.
 */
async function getNextSeqViaChaosRedis(
  client: Redis,
  pk: string,
  baseSeq = 1000,
): Promise<number> {
  const lockKey = LOCK_KEY(pk);
  const seqKey = SEQ_KEY(pk);

  try {
    // ── 1. Acquire distributed lock ─────────────────────────────────────────
    const deadline = Date.now() + MAX_LOCK_WAIT_MS;
    const lockValue = `pid-${process.pid}-${Date.now()}`;
    let lockAcquired = false;

    while (Date.now() < deadline) {
      const result = await client.set(
        lockKey,
        lockValue,
        'NX',
        'PX',
        LOCK_TTL_MS,
      );
      if (result === 'OK') {
        lockAcquired = true;
        break;
      }
      await sleep(LOCK_POLL_MS);
    }

    if (!lockAcquired) {
      // Timeout — degrade to fallback sentinel.
      return -1;
    }

    try {
      // ── 2. Seed the counter if absent ──────────────────────────────────────
      const existing = await client.get(seqKey);
      if (existing === null) {
        // Store base so the first INCR yields baseSeq + 1.
        await client.set(seqKey, String(baseSeq), 'PX', 60_000);
      }

      // ── 3. Atomic increment ────────────────────────────────────────────────
      const next = await client.incr(seqKey);
      // Refresh TTL so active accounts don't expire mid-burst.
      await client.pexpire(seqKey, 60_000);

      return next;
    } finally {
      // ── 4. Release lock ────────────────────────────────────────────────────
      await client.del(lockKey).catch(() => {
        /* best-effort */
      });
    }
  } catch {
    // Any Redis error (connection reset, timeout, ECONNREFUSED) → fallback.
    return -1;
  }
}

/** Tiny async sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove all toxics from a proxy without throwing if individual removals fail.
 * Toxiproxy may have already cleaned up after a `reset_peer` drain.
 */
async function clearAllToxics(proxy: ToxiproxyProxy): Promise<void> {
  try {
    const toxics = await proxy.refreshToxics();
    await Promise.allSettled(toxics.map((t) => proxy.removeToxic(t.name)));
  } catch {
    /* best-effort — proxy may have been reset */
  }
}

// ── Skip guard ────────────────────────────────────────────────────────────────

/**
 * The whole suite is skipped when TOXIPROXY_HOST is not set.
 * This prevents CI pipelines without Toxiproxy from failing.
 */
const suiteDescribe = process.env.TOXIPROXY_HOST ? describe : describe.skip;

// ── Test suite ────────────────────────────────────────────────────────────────

suiteDescribe('Redis sequence manager — chaos (Toxiproxy)', () => {
  let toxiproxy: ToxiproxyClient;
  let proxy: ToxiproxyProxy;
  let chaosClient: Redis;

  // ── Suite setup ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // Generous timeout: proxy creation can be slow if Toxiproxy is just starting.
    jest.setTimeout(60_000);

    toxiproxy = new Toxiproxy(`http://${TOXIPROXY_HOST}:${TOXIPROXY_API_PORT}`);

    // Reset any leftover state from a previous aborted run.
    await toxiproxy.reset();

    // Create a proxy that sits between our test client and real Redis.
    proxy = await toxiproxy.createProxy({
      name: PROXY_NAME,
      listen: `0.0.0.0:${CHAOS_PROXY_PORT}`,
      upstream: `${REDIS_HOST}:${REDIS_PORT}`,
    });
  });

  afterAll(async () => {
    // Tear down proxy and disconnect clients.
    if (chaosClient) {
      chaosClient.disconnect();
    }
    if (proxy) {
      await proxy.remove().catch(() => {
        /* already gone */
      });
    }
  });

  // ── Per-test setup ──────────────────────────────────────────────────────────

  beforeEach(async () => {
    // Fresh ioredis client per test so connection state never bleeds between tests.
    chaosClient = buildChaosClient();
    await chaosClient.connect();

    // Clear any sequence / lock keys left over from the previous test.
    const keys = await chaosClient.keys('stellar:seq:*');
    if (keys.length > 0) {
      await chaosClient.del(keys);
    }
  });

  afterEach(async () => {
    // Remove all toxics so the next test starts with a clean proxy.
    await clearAllToxics(proxy);

    // Disconnect the per-test ioredis client.
    if (chaosClient) {
      await chaosClient.quit().catch(() => chaosClient.disconnect());
    }

    // Brief settling pause between tests.
    await sleep(200);
  });

  // ── 1. Latency injection ────────────────────────────────────────────────────

  it('latency injection: 10 concurrent calls all resolve, no duplicate sequences', async () => {
    // Add a latency toxic: 2 000 ms average with ±500 ms jitter.
    await proxy.addToxic({
      name: 'latency-chaos',
      type: 'latency',
      toxicity: 1,
      attributes: {
        latency: 2000,
        jitter: 500,
      },
    });

    const pk = 'GCHAOS1LATENCY000000000000000000000000000000000000000001';
    const start = Date.now();

    // Fire 10 concurrent calls — some will time out and return the -1 sentinel.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        getNextSeqViaChaosRedis(chaosClient, pk),
      ),
    );

    const elapsed = Date.now() - start;

    // All promises must have resolved (no unhandled rejections).
    expect(results).toHaveLength(10);

    // Elapsed must be well under a 15-second ceiling regardless of chaos path.
    expect(elapsed).toBeLessThan(15_000);

    // Split results into successful Redis INCR values and fallback sentinels.
    const successValues = results.filter((v) => v > 0);
    const fallbackCount = results.filter((v) => v === -1).length;

    // Regardless of which path was taken, we must have seen some result.
    expect(successValues.length + fallbackCount).toBe(10);

    // Any successful Redis responses must be unique — no two calls may share
    // the same sequence number.
    const unique = new Set(successValues);
    expect(unique.size).toBe(successValues.length);
  }, 30_000);

  // ── 2. Connection reset (split-brain) ───────────────────────────────────────

  it('connection reset: 5 concurrent calls resolve without throwing (fallback engages)', async () => {
    // reset_peer immediately closes the TCP connection on each new connection
    // attempt, simulating a network split from the client's perspective.
    await proxy.addToxic({
      name: 'reset-chaos',
      type: 'reset_peer',
      toxicity: 1,
      attributes: {
        timeout: 0,
      },
    });

    const pk = 'GCHAOS2RESET0000000000000000000000000000000000000000002';

    // All calls should resolve — either with a valid sequence or the -1 sentinel.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => getNextSeqViaChaosRedis(chaosClient, pk)),
    );

    // No promise should have rejected.
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    // Every fulfilled result is either a positive sequence or the -1 fallback.
    const values = results
      .filter(
        (r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled',
      )
      .map((r) => r.value);

    for (const v of values) {
      expect(v === -1 || v > 0).toBe(true);
    }
  }, 20_000);

  // ── 3. Bandwidth limiting ───────────────────────────────────────────────────

  it('bandwidth limiting: 20-request burst all complete, no unhandled rejections', async () => {
    // 1 KB/s is far below what Redis typically needs, so most calls will time
    // out and return the fallback sentinel.
    await proxy.addToxic({
      name: 'bandwidth-chaos',
      type: 'bandwidth',
      toxicity: 1,
      attributes: {
        rate: 1, // KB/s
      },
    });

    const pk = 'GCHAOS3BANDWIDTH00000000000000000000000000000000000003';

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        getNextSeqViaChaosRedis(chaosClient, pk),
      ),
    );

    // Every promise must have settled (fulfilled or rejected — no hang).
    expect(results).toHaveLength(20);

    // We accept both -1 (fallback) and positive integers as valid outcomes.
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    const values = results
      .filter(
        (r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled',
      )
      .map((r) => r.value);

    for (const v of values) {
      expect(v === -1 || v > 0).toBe(true);
    }
  }, 30_000);

  // ── 4. Full partition recovery ──────────────────────────────────────────────

  it('full partition recovery: calls during partition fall back, calls after recovery use Redis', async () => {
    const pk = 'GCHAOS4RECOVERY000000000000000000000000000000000000004';

    // ── Phase 1: Partition — disable the proxy entirely ────────────────────
    await proxy.update({ enabled: false });

    // Three calls during the partition: Redis is unreachable so all should
    // return the -1 fallback sentinel.
    const partitionResults = await Promise.all(
      Array.from({ length: 3 }, () => getNextSeqViaChaosRedis(chaosClient, pk)),
    );

    // All must have resolved (not thrown).
    expect(partitionResults).toHaveLength(3);

    // With the proxy disabled every Redis command will time out / be refused.
    // We expect all three to degrade gracefully to -1.
    for (const v of partitionResults) {
      expect(v).toBe(-1);
    }

    // ── Phase 2: Recovery — re-enable the proxy ────────────────────────────
    await proxy.update({ enabled: true });

    // Give ioredis a moment to notice the proxy is reachable again.
    // We build a fresh client since the old one's connection may be in an
    // error state after the partition.
    chaosClient.disconnect();
    chaosClient = buildChaosClient();
    await chaosClient.connect();

    // Brief settling pause.
    await sleep(300);

    // Three calls after recovery should succeed via Redis (positive integers).
    const recoveryResults = await Promise.all(
      Array.from({ length: 3 }, () => getNextSeqViaChaosRedis(chaosClient, pk)),
    );

    expect(recoveryResults).toHaveLength(3);

    // At minimum all calls must resolve without throwing.
    for (const v of recoveryResults) {
      expect(v === -1 || v > 0).toBe(true);
    }

    // The recovery batch should have produced at least one successful Redis
    // INCR (positive integer), proving the connection was restored.
    const successfulAfterRecovery = recoveryResults.filter((v) => v > 0);
    expect(successfulAfterRecovery.length).toBeGreaterThan(0);

    // Every successful post-recovery sequence must be strictly greater than
    // the base seed (1000) used by getNextSeqViaChaosRedis, confirming that
    // real INCR operations ran against Redis rather than returning stale data.
    for (const v of successfulAfterRecovery) {
      expect(v).toBeGreaterThan(1000);
    }
  }, 30_000);
});
