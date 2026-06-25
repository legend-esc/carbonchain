import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HealthService } from '../src/health/health.service';

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

    afterAll(() => app.close());

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

    afterAll(() => app.close());

    it('GET /health returns 503 with the failing dependency marked as error', () => {
      return request(app.getHttpServer())
        .get('/health')
        .expect(503)
        .expect({ status: 'error', db: 'error', stellar: 'ok' });
    });
  });
});
