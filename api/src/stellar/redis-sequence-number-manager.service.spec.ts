import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../common/cache.service';
import { SequenceNumberManager } from './sequence-number-manager.service';
import { RedisSequenceNumberManager } from './redis-sequence-number-manager.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRedisClient(overrides: Partial<{
  get: jest.Mock;
  set: jest.Mock;
  incr: jest.Mock;
  pexpire: jest.Mock;
  del: jest.Mock;
  scan: jest.Mock;
}> = {}) {
  const client = {
    get: jest.fn(),
    set: jest.fn(),
    incr: jest.fn(),
    pexpire: jest.fn(),
    del: jest.fn(),
    scan: jest.fn(),
    ...overrides,
  };
  return client;
}

function buildCacheService(client: any, connected = true): CacheService {
  const service = {
    isConnected: connected,
    client,
  } as unknown as CacheService;
  return service;
}

async function buildManager({
  client,
  connected = true,
  seqTtlMs = 60_000,
  inMemoryResults,
}: {
  client?: any;
  connected?: boolean;
  seqTtlMs?: number;
  inMemoryResults?: Record<string, number[]>;
} = {}): Promise<{
  manager: RedisSequenceNumberManager;
  cacheService: CacheService;
  redisClient: any;
  inMemory: SequenceNumberManager;
}> {
  const redisClient = client ?? buildRedisClient();
  const cacheService = buildCacheService(redisClient, connected);

  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'SEQ_CACHE_TTL_MS') return String(seqTtlMs);
      return undefined;
    }),
  } as unknown as ConfigService;

  const inMemory = new SequenceNumberManager(configService);

  // Pre-seed in-memory results if provided.
  if (inMemoryResults) {
    for (const [pk, seqs] of Object.entries(inMemoryResults)) {
      for (const seq of seqs) {
        inMemory.cacheSequenceNumber(pk, seq);
      }
    }
  }

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      RedisSequenceNumberManager,
      { provide: ConfigService, useValue: configService },
      { provide: CacheService, useValue: cacheService },
      { provide: SequenceNumberManager, useValue: inMemory },
    ],
  }).compile();

  const manager = module.get<RedisSequenceNumberManager>(RedisSequenceNumberManager);
  return { manager, cacheService, redisClient, inMemory };
}

const PK_A = 'GD72EF...FH3W9A';
const PK_B = 'GB84GH...JK2L8Z';

describe('RedisSequenceNumberManager', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Constructor / TTL ──────────────────────────────────────────────────────

  it('uses default 60s TTL when SEQ_CACHE_TTL_MS is not set', async () => {
    const { manager } = await buildManager({});
    // Access private field for assertion via cast.
    const ttl = (manager as any).seqTtlMs;
    expect(ttl).toBe(60_000);
  });

  it('uses configured TTL from SEQ_CACHE_TTL_MS env var', async () => {
    const { manager } = await buildManager({ seqTtlMs: 5_000 });
    expect((manager as any).seqTtlMs).toBe(5_000);
  });

  // ── getNextSequenceNumberAtomic ────────────────────────────────────────────

  it('falls back to in-memory manager when Redis is not connected', async () => {
    const { manager, redisClient, inMemory } = await buildManager({ connected: false });
    const fetchFn = jest.fn<Promise<number>, []>().mockResolvedValue(100);
    const spy = jest.spyOn(inMemory, 'getNextSequenceNumberAtomic');

    const seq = await manager.getNextSequenceNumberAtomic(PK_A, fetchFn);
    expect(seq).toBe(100);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    expect(redisClient.get).not.toHaveBeenCalled();
  });

  it('seeds from Horizon on cold cache and returns next sequence via INCR', async () => {
    const { manager, redisClient } = await buildManager({});
    redisClient.get.mockResolvedValue(null); // cache cold
    redisClient.incr.mockResolvedValue(101);
    redisClient.set.mockResolvedValue('OK');
    redisClient.pexpire.mockResolvedValue('OK');

    const fetchFn = jest.fn<Promise<number>, []>().mockResolvedValue(100);
    const seq = await manager.getNextSequenceNumberAtomic(PK_A, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Seed: set key to horizon seq (100) with PX TTL
    expect(redisClient.set).toHaveBeenCalledWith(
      `stellar:seq:${PK_A}`,
      '100',
      'PX',
      60_000,
    );
    // INCR returns next sequence (101)
    expect(redisClient.incr).toHaveBeenCalledWith(`stellar:seq:${PK_A}`);
    expect(redisClient.pexpire).toHaveBeenCalledWith(`stellar:seq:${PK_A}`, 60_000);
    expect(seq).toBe(101);
  });

  it('uses cached counter via INCR when cache is warm', async () => {
    const { manager, redisClient } = await buildManager({});
    redisClient.get.mockResolvedValue('200'); // warm cache
    redisClient.incr.mockResolvedValue(201);
    redisClient.pexpire.mockResolvedValue('OK');

    const fetchFn = jest.fn<Promise<number>, []>();
    const seq = await manager.getNextSequenceNumberAtomic(PK_A, fetchFn);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(redisClient.incr).toHaveBeenCalledWith(`stellar:seq:${PK_A}`);
    expect(seq).toBe(201);
    expect(redisClient.pexpire).toHaveBeenCalledWith(`stellar:seq:${PK_A}`, 60_000);
  });

  it('returns sequential numbers across concurrent calls for the same key', async () => {
    const { manager, redisClient } = await buildManager({});
    redisClient.get.mockResolvedValue(null);
    redisClient.set.mockResolvedValue('OK');
    redisClient.incr.mockImplementation(() => {
      const key = `stellar:seq:${PK_A}`;
      return Promise.resolve(101);
    });
    redisClient.pexpire.mockResolvedValue('OK');

    const fetchFn = jest.fn<Promise<number>, []>().mockResolvedValue(100);
    const CONCURRENCY = 10;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        manager.getNextSequenceNumberAtomic(PK_A, fetchFn),
      ),
    );

    const unique = new Set(results);
    expect(unique.size).toBe(CONCURRENCY);
    expect(fetchFn).toHaveBeenCalledTimes(1); // seeded once by first caller
  });

  it('falls back to in-memory when lock cannot be acquired', async () => {
    const { manager, redisClient, inMemory } = await buildManager({});
    redisClient.get.mockResolvedValue(null);
    redisClient.set.mockImplementation(() => {
      // simulate lock always held → SET NX returns null
      return Promise.resolve(null);
    });
    const spy = jest.spyOn(inMemory, 'getNextSequenceNumberAtomic').mockResolvedValue(50);
    const fetchFn = jest.fn<Promise<number>, []>().mockResolvedValue(100);

    const seq = await manager.getNextSequenceNumberAtomic(PK_A, fetchFn);
    expect(seq).toBe(50);
    expect(spy).toHaveBeenCalled();
  });

  it('falls back to in-memory when redis client is unavailable', async () => {
    const { manager, inMemory } = await buildManager({ client: null, connected: true });
    const spy = jest.spyOn(inMemory, 'getNextSequenceNumberAtomic').mockResolvedValue(77);
    const fetchFn = jest.fn<Promise<number>, []>().mockResolvedValue(100);

    const seq = await manager.getNextSequenceNumberAtomic(PK_A, fetchFn);
    expect(seq).toBe(77);
    expect(spy).toHaveBeenCalled();
  });

  // ── cacheSequenceNumber ────────────────────────────────────────────────────

  it('caches sequence number in Redis with TTL', async () => {
    const { manager, redisClient } = await buildManager({});
    redisClient.set.mockResolvedValue('OK');

    await manager.cacheSequenceNumber(PK_A, 42);
    expect(redisClient.set).toHaveBeenCalledWith(
      `stellar:seq:${PK_A}`,
      '42',
      'PX',
      60_000,
    );
  });

  it('falls back to in-memory cacheSequenceNumber when Redis disconnected', async () => {
    const { manager, inMemory } = await buildManager({ connected: false });
    const spy = jest.spyOn(inMemory, 'cacheSequenceNumber');
    await manager.cacheSequenceNumber(PK_A, 42);
    expect(spy).toHaveBeenCalledWith(PK_A, 42);
  });

  // ── reset ──────────────────────────────────────────────────────────────────

  it('resets sequence key in Redis and in-memory fallback', async () => {
    const { manager, redisClient, inMemory } = await buildManager({});
    redisClient.del.mockResolvedValue(1);
    const spy = jest.spyOn(inMemory, 'reset');

    await manager.reset(PK_A);
    expect(spy).toHaveBeenCalledWith(PK_A);
    expect(redisClient.del).toHaveBeenCalledWith(`stellar:seq:${PK_A}`);
  });

  // ── clear ──────────────────────────────────────────────────────────────────

  it('clears all stellar:seq keys via SCAN and DEL', async () => {
    const { manager, redisClient } = await buildManager({});
    redisClient.scan.mockResolvedValueOnce(['0', ['stellar:seq:aaa', 'stellar:seq:bbb']]);
    redisClient.del.mockResolvedValue(2);
    const inMemoryClear = jest.fn();
    // Clear also calls inMemoryFallback.clear — mock via replace.
    (manager as any).inMemoryFallback.clear = inMemoryClear;

    await manager.clear();
    expect(inMemoryClear).toHaveBeenCalled();
    expect(redisClient.scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      'stellar:seq:[^l]*',
      'COUNT',
      100,
    );
    expect(redisClient.del).toHaveBeenCalledWith(['stellar:seq:aaa', 'stellar:seq:bbb']);
  });

  it('clear handles empty scan results gracefully', async () => {
    const { manager, redisClient } = await buildManager({});
    redisClient.scan.mockResolvedValueOnce(['0', []]);
    (manager as any).inMemoryFallback.clear = jest.fn();

    await manager.clear();
    expect(redisClient.del).not.toHaveBeenCalled();
  });
});
