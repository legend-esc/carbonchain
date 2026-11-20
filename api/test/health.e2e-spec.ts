import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HealthService } from '../src/health/health.service';
import { CacheService } from '../src/common/cache.service';

/**
 * Issue #188 — GET /health reports overall status plus per-dependency status.
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  describe('when Postgres and Soroban RPC are reachable', () => {
    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(HealthService)
        .useValue({
          check: async () => ({ status: 'ok', db: 'ok', stellar: 'ok' }),
        })
        .compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /health returns 200 with status/db/stellar ok', () => {
      return request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok', db: 'ok', stellar: 'ok' });
    });
  });

  describe('when a dependency is unreachable', () => {
    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(HealthService)
        .useValue({
          check: async () => ({ status: 'error', db: 'error', stellar: 'ok' }),
        })
        .compile();

      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /health returns 503 with the failing dependency marked as error', () => {
      return request(app.getHttpServer())
        .get('/health')
        .expect(503)
        .expect({ status: 'error', db: 'error', stellar: 'ok' });
    });
  });
});

/**
 * Issue #1186 — GET /health/redis reports Redis connectivity and ping latency.
 */
describe('Health Redis (e2e)', () => {
  let app: INestApplication;

  const buildApp = async (healthCheck: () => Promise<any>) => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CacheService)
      .useValue({ healthCheck })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  };

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /health/redis returns 200 with ok status and latency', async () => {
    await buildApp(async () => ({ status: 'ok', latencyMs: 3 }));

    return request(app.getHttpServer())
      .get('/health/redis')
      .expect(200)
      .expect({ status: 'ok', latencyMs: 3 });
  });

  it('GET /health/redis returns 200 with degraded status when latency is high', async () => {
    await buildApp(async () => ({ status: 'degraded', latencyMs: 250 }));

    return request(app.getHttpServer())
      .get('/health/redis')
      .expect(200)
      .expect({ status: 'degraded', latencyMs: 250 });
  });

  it('GET /health/redis returns 503 with down status when ping throws', async () => {
    await buildApp(async () => ({ status: 'down', latencyMs: 0 }));

    return request(app.getHttpServer())
      .get('/health/redis')
      .expect(503)
      .expect({ status: 'down', latencyMs: 0 });
  });

  it('GET /health/redis returns 503 with down status when no client is available', async () => {
    await buildApp(async () => ({ status: 'down', latencyMs: 0 }));

    return request(app.getHttpServer())
      .get('/health/redis')
      .expect(503)
      .expect({ status: 'down', latencyMs: 0 });
  });
});
