import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CacheService } from './cache.service';

// ---------------------------------------------------------------------------
// Mock Redis client
// ---------------------------------------------------------------------------

const mockRedisClient = {
  isOpen: true,
  connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue(undefined),
  get: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  keys: jest.fn().mockResolvedValue([]),
  sAdd: jest.fn().mockResolvedValue(1),
  sMembers: jest.fn().mockResolvedValue([]),
  expire: jest.fn().mockResolvedValue(true),
  on: jest.fn(),
};

// Intercept `createClient` from the `redis` package
jest.mock('redis', () => ({
  createClient: jest.fn(() => mockRedisClient),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildModule(redisUrl: string | undefined): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      CacheService,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, def?: unknown) => {
            if (key === 'REDIS_URL') return redisUrl;
            if (key === 'CACHE_TTL_SECONDS') return 60;
            return def;
          }),
        },
      },
    ],
  }).compile();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CacheService', () => {
  let service: CacheService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedisClient.isOpen = true;
    const module = await buildModule('redis://localhost:6379');
    service = module.get<CacheService>(CacheService);
    await service.connect();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('creates the service', () => {
    expect(service).toBeTruthy();
  });

  it('isConnected returns true after successful connect', () => {
    expect(service.isConnected).toBe(true);
  });

  // ── get ──────────────────────────────────────────────────────────────────

  it('get() returns null on cache miss', async () => {
    mockRedisClient.get.mockResolvedValue(null);
    const result = await service.get('missing-key');
    expect(result).toBeNull();
  });

  it('get() deserialises a cached JSON value', async () => {
    const payload = { id: 'abc', status: 'Active' };
    mockRedisClient.get.mockResolvedValue(JSON.stringify(payload));
    const result = await service.get<typeof payload>('credits:abc');
    expect(result).toEqual(payload);
  });

  it('get() returns null and does not throw when Redis errors', async () => {
    mockRedisClient.get.mockRejectedValue(new Error('connection lost'));
    await expect(service.get('key')).resolves.toBeNull();
  });

  // ── set ──────────────────────────────────────────────────────────────────

  it('set() calls redis SET with EX option', async () => {
    await service.set('credits:abc', { id: 'abc' }, 30);
    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'credits:abc',
      JSON.stringify({ id: 'abc' }),
      { EX: 30 },
    );
  });

  it('set() uses default TTL when none provided', async () => {
    await service.set('credits:xyz', { id: 'xyz' });
    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'credits:xyz',
      expect.any(String),
      { EX: 60 },
    );
  });

  it('set() does not throw when Redis errors', async () => {
    mockRedisClient.set.mockRejectedValue(new Error('write error'));
    await expect(service.set('key', 'value')).resolves.toBeUndefined();
  });

  // ── del ──────────────────────────────────────────────────────────────────

  it('del() calls redis DEL with the given keys', async () => {
    await service.del('credits:a', 'credits:b');
    expect(mockRedisClient.del).toHaveBeenCalledWith([
      'credits:a',
      'credits:b',
    ]);
  });

  it('del() is a no-op when no keys are provided', async () => {
    await service.del();
    expect(mockRedisClient.del).not.toHaveBeenCalled();
  });

  // ── delPattern ───────────────────────────────────────────────────────────

  it('delPattern() deletes all keys matching the pattern', async () => {
    mockRedisClient.keys.mockResolvedValue([
      'credits:list:1',
      'credits:list:2',
    ]);
    await service.delPattern('credits:list:*');
    expect(mockRedisClient.del).toHaveBeenCalledWith([
      'credits:list:1',
      'credits:list:2',
    ]);
  });

  it('delPattern() is a no-op when no keys match', async () => {
    mockRedisClient.keys.mockResolvedValue([]);
    await service.delPattern('credits:list:*');
    expect(mockRedisClient.del).not.toHaveBeenCalled();
  });

  // ── setTagged / invalidateTag (issue #540) ─────────────────────────────────

  it('setTagged() sets the value and registers the key against every tag', async () => {
    await service.setTagged('credits:list:foo', { a: 1 }, ['credits:list'], 60);

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'credits:list:foo',
      JSON.stringify({ a: 1 }),
      { EX: 60 },
    );
    expect(mockRedisClient.sAdd).toHaveBeenCalledWith(
      'cache:tag:credits:list',
      'credits:list:foo',
    );
    expect(mockRedisClient.expire).toHaveBeenCalledWith(
      'cache:tag:credits:list',
      60,
    );
  });

  it('setTagged() registers a key against multiple tags', async () => {
    await service.setTagged('credits:abc', { id: 'abc' }, [
      'credit:abc',
      'credits:list',
    ]);

    expect(mockRedisClient.sAdd).toHaveBeenCalledWith(
      'cache:tag:credit:abc',
      'credits:abc',
    );
    expect(mockRedisClient.sAdd).toHaveBeenCalledWith(
      'cache:tag:credits:list',
      'credits:abc',
    );
  });

  it('invalidateTag() deletes only the keys registered under that tag, not the whole keyspace', async () => {
    mockRedisClient.sMembers.mockResolvedValue([
      'credits:list:a',
      'credits:list:b',
    ]);

    await service.invalidateTag('credits:list');

    expect(mockRedisClient.sMembers).toHaveBeenCalledWith(
      'cache:tag:credits:list',
    );
    expect(mockRedisClient.del).toHaveBeenCalledWith([
      'credits:list:a',
      'credits:list:b',
    ]);
    // The tag set itself is removed too, so a stale entry can't leak next round.
    expect(mockRedisClient.del).toHaveBeenCalledWith('cache:tag:credits:list');
    // No KEYS scan of the wider keyspace — targeted invalidation only.
    expect(mockRedisClient.keys).not.toHaveBeenCalled();
  });

  it('invalidateTag() is a no-op DEL when no keys are tagged', async () => {
    mockRedisClient.sMembers.mockResolvedValue([]);
    await service.invalidateTag('credits:list');
    expect(mockRedisClient.del).toHaveBeenCalledWith('cache:tag:credits:list');
    expect(mockRedisClient.del).not.toHaveBeenCalledWith([]);
  });

  // ── no-op mode (no REDIS_URL) ─────────────────────────────────────────────

  it('operates in no-op mode when REDIS_URL is not set', async () => {
    jest.clearAllMocks();
    const module = await buildModule(undefined);
    const noopService = module.get<CacheService>(CacheService);
    await noopService.connect();

    expect(noopService.isConnected).toBe(false);
    expect(await noopService.get('key')).toBeNull();
    await expect(noopService.set('key', 'val')).resolves.toBeUndefined();
    await expect(noopService.del('key')).resolves.toBeUndefined();
    await expect(noopService.delPattern('*')).resolves.toBeUndefined();
  });
});
