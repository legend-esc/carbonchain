import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OracleModule } from '../src/oracle/oracle.module';
import { OracleService, OracleStatusResponse } from '../src/oracle/oracle.service';
import { CacheService } from '../src/common/cache.service';
import { ConfigModule } from '@nestjs/config';

/**
 * Issue #1169 — GET /oracle/status returns oracle health info.
 *
 * The service layer is mocked so no Stellar RPC calls are needed.
 */
describe('Oracle status endpoint (e2e) — Issue #1169', () => {
  let app: INestApplication;

  const mockStatus: OracleStatusResponse = {
    paused: false,
    oracleCount: 3,
    globalThresholdBps: 2000,
    lastUpdatePerProject: [
      {
        projectId: 'PROJ-001',
        lastUpdate: null,
      },
    ],
  };

  beforeAll(async () => {
    const fakeCache = {
      get: jest.fn(async () => null),
      set: jest.fn(async () => true),
      del: jest.fn(async () => undefined),
      connect: jest.fn(async () => undefined),
    } as unknown as CacheService;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        OracleModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      ],
    })
      .overrideProvider(CacheService)
      .useValue(fakeCache)
      .overrideProvider(OracleService)
      .useValue({
        getOracleStatus: jest.fn(async () => mockStatus),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /oracle/status returns 200 with health info', async () => {
    const res = await request(app.getHttpServer())
      .get('/oracle/status')
      .expect(200);

    expect(res.body).toEqual(mockStatus);
    expect(res.body).toHaveProperty('paused');
    expect(res.body).toHaveProperty('oracleCount');
    expect(res.body).toHaveProperty('globalThresholdBps');
    expect(res.body).toHaveProperty('lastUpdatePerProject');
  });

  it('GET /oracle/status is public (no auth required)', async () => {
    await request(app.getHttpServer())
      .get('/oracle/status')
      .expect(200);
  });

  it('GET /oracle/status includes paused, oracle count, and threshold', async () => {
    const res = await request(app.getHttpServer())
      .get('/oracle/status')
      .expect(200);

    expect(res.body.paused).toBe(false);
    expect(res.body.oracleCount).toBe(3);
    expect(res.body.globalThresholdBps).toBe(2000);
  });
});

/**
 * Service-level test: verify getOracleStatus aggregates three contract calls
 * and caches the result with 30s TTL.
 */
describe('OracleService.getOracleStatus — Issue #1169', () => {
  it('calls paused, get_oracle_count, get_anomaly_threshold and caches 30s', async () => {
    const cacheStore = new Map<string, unknown>();
    const fakeCache = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown, ttl: number) => {
        cacheStore.set(key, value);
        expect(ttl).toBe(30);
        return true;
      }),
      del: jest.fn(async (key: string) => {
        cacheStore.delete(key);
      }),
      connect: jest.fn(async () => undefined),
    } as unknown as CacheService;

    const mockConfig = {
      get: (key: string, fallback?: unknown) => {
        if (key === 'MRV_ORACLE_CONTRACT_ID') return 'CTORACLE123';
        if (key === 'ORACLE_WEBHOOK_SECRET') return 'test-secret';
        if (key === 'ORACLE_STATUS_PROJECTS') return 'PROJ-001';
        if (key === 'NODE_ENV') return 'test';
        return fallback;
      },
    } as any;

    const mockStellar = {
      readContract: jest.fn(async (_id: string, method: string, _args: any) => {
        if (method === 'paused') return { value: false } as any;
        if (method === 'get_oracle_count') return { value: 5 } as any;
        if (method === 'get_anomaly_threshold') return { value: 2000 } as any;
        if (method === 'get_latest') {
          return {
            value: {
              oracle: 'GORACLE1',
              project_id: 'PROJ-001',
              tonnes: '1000000',
              recorded_at: 1735689600,
              anomaly: false,
            },
          } as any;
        }
        return undefined;
      }),
    } as any;

    const mockKeypair = { getAdminKeypair: () => ({ publicKey: () => 'GADMIN' }) } as any;

    // Import after mocking context — we use the real service with mocked deps
    const { OracleService } = await import('../src/oracle/oracle.service');
    const service = new OracleService(mockStellar, mockKeypair, mockConfig, fakeCache);

    const result = await service.getOracleStatus();

    expect(result.paused).toBe(false);
    expect(result.oracleCount).toBe(5);
    expect(result.globalThresholdBps).toBe(2000);
    expect(result.lastUpdatePerProject).toHaveLength(1);
    expect(result.lastUpdatePerProject[0].projectId).toBe('PROJ-001');

    // Verify caching: second call should not re-invoke the contract
    const readSpy = mockStellar.readContract.mock;
    const firstCallCount = readSpy.calls.length;

    const result2 = await service.getOracleStatus();
    expect(result2).toEqual(result);
    // No additional contract reads (cache hit)
    expect(readSpy.calls.length).toBe(firstCallCount);
  });

  it('returns cached result on subsequent calls', async () => {
    const cacheStore = new Map<string, unknown>();
    const cachedResult: OracleStatusResponse = {
      paused: true,
      oracleCount: 2,
      globalThresholdBps: 1000,
      lastUpdatePerProject: [],
    };
    cacheStore.set('oracle:status', cachedResult);

    const fakeCache = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async () => true),
      del: jest.fn(async () => undefined),
      connect: jest.fn(async () => undefined),
    } as unknown as CacheService;

    const mockConfig = {
      get: (key: string, fallback?: unknown) => {
        if (key === 'MRV_ORACLE_CONTRACT_ID') return 'CTORACLE123';
        if (key === 'ORACLE_WEBHOOK_SECRET') return 'test-secret';
        if (key === 'NODE_ENV') return 'test';
        return fallback;
      },
    } as any;

    const mockStellar = {
      readContract: jest.fn(async () => ({} as any)),
    } as any;

    const mockKeypair = { getAdminKeypair: () => ({ publicKey: () => 'GADMIN' }) } as any;

    const { OracleService } = await import('../src/oracle/oracle.service');
    const service = new OracleService(mockStellar, mockKeypair, mockConfig, fakeCache);

    const result = await service.getOracleStatus();

    // Should return the cached value without calling the contract
    expect(result).toEqual(cachedResult);
    expect(mockStellar.readContract).not.toHaveBeenCalled();
  });
});
