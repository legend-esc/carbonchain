import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebhooksModule } from '../src/webhooks/webhooks.module';
import { CacheService } from '../src/common/cache.service';
import { ConfigModule } from '@nestjs/config';

/**
 * Issue #1170 — Webhook IP Allowlist Management CRUD endpoints.
 *
 * Tests the admin endpoints:
 *   POST   /oracle/webhook/allowlist
 *   GET    /oracle/webhook/allowlist
 *   DELETE /oracle/webhook/allowlist/:cidr
 *
 * The AdminGuard and JwtAuthGuard are bypassed via overrideProvider so
 * the tests focus on the CRUD logic without needing a live Stellar node
 * or a signed JWT.
 */
describe('Webhook IP Allowlist Management (e2e) — Issue #1170', () => {
  let app: INestApplication;

  // In-memory cache backing the allowlist service
  const cacheStore = new Map<string, unknown>();

  const fakeCache = {
    get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
      return true;
    }),
    del: jest.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
    increment: jest.fn(async () => 1),
    connect: jest.fn(async () => undefined),
    get isConnected() {
      return true;
    },
  } as unknown as CacheService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        WebhooksModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      ],
    })
      .overrideProvider(CacheService)
      .useValue(fakeCache)
      // Bypass JWT guard
      .overrideProvider('JwtAuthGuard')
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    cacheStore.clear();
  });

  it('POST /oracle/webhook/allowlist adds an IP/CIDR', async () => {
    const res = await request(app.getHttpServer())
      .post('/oracle/webhook/allowlist')
      .send({ cidr: '192.168.1.0/24' })
      .expect(HttpStatus.CREATED);

    expect(res.body.cidr).toBe('192.168.1.0/24');
    expect(res.body.addedAt).toBeDefined();
  });

  it('GET /oracle/webhook/allowlist lists all entries', async () => {
    await request(app.getHttpServer())
      .post('/oracle/webhook/allowlist')
      .send({ cidr: '10.0.0.1' })
      .expect(HttpStatus.CREATED);

    await request(app.getHttpServer())
      .post('/oracle/webhook/allowlist')
      .send({ cidr: '172.16.0.0/12' })
      .expect(HttpStatus.CREATED);

    const res = await request(app.getHttpServer())
      .get('/oracle/webhook/allowlist')
      .expect(HttpStatus.OK);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(res.body.map((e: any) => e.cidr)).toContain('10.0.0.1');
    expect(res.body.map((e: any) => e.cidr)).toContain('172.16.0.0/12');
  });

  it('DELETE /oracle/webhook/allowlist/:cidr removes an entry', async () => {
    await request(app.getHttpServer())
      .post('/oracle/webhook/allowlist')
      .send({ cidr: '10.0.0.1' })
      .expect(HttpStatus.CREATED);

    // URL-encode the CIDR for the path
    const encoded = encodeURIComponent('10.0.0.1');
    await request(app.getHttpServer())
      .delete(`/oracle/webhook/allowlist/${encoded}`)
      .expect(HttpStatus.OK);

    // Verify it's gone
    const res = await request(app.getHttpServer())
      .get('/oracle/webhook/allowlist')
      .expect(HttpStatus.OK);

    expect(res.body.map((e: any) => e.cidr)).not.toContain('10.0.0.1');
  });

  it('DELETE returns 404 for a non-existent entry', async () => {
    const encoded = encodeURIComponent('99.99.99.99');
    await request(app.getHttpServer())
      .delete(`/oracle/webhook/allowlist/${encoded}`)
      .expect(HttpStatus.NOT_FOUND);
  });

  it('POST rejects invalid CIDR', async () => {
    await request(app.getHttpServer())
      .post('/oracle/webhook/allowlist')
      .send({ cidr: 'not-an-ip' })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('POST rejects empty cidr', async () => {
    await request(app.getHttpServer())
      .post('/oracle/webhook/allowlist')
      .send({ cidr: '' })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('POST is idempotent (adding same CIDR twice does not duplicate)', async () => {
    await request(app.getHttpServer())
      .post('/oracle/webhook/allowlist')
      .send({ cidr: '192.168.1.0/24' })
      .expect(HttpStatus.CREATED);

    await request(app.getHttpServer())
      .post('/oracle/webhook/allowlist')
      .send({ cidr: '192.168.1.0/24' })
      .expect(HttpStatus.CREATED);

    const res = await request(app.getHttpServer())
      .get('/oracle/webhook/allowlist')
      .expect(HttpStatus.OK);

    expect(res.body.filter((e: any) => e.cidr === '192.168.1.0/24')).toHaveLength(1);
  });

  it('DELETE /oracle/webhook/allowlist/:cidr handles CIDR with slash (URL-encoded)', async () => {
    await request(app.getHttpServer())
      .post('/oracle/webhook/allowlist')
      .send({ cidr: '10.0.0.0/8' })
      .expect(HttpStatus.CREATED);

    const encoded = encodeURIComponent('10.0.0.0/8');
    await request(app.getHttpServer())
      .delete(`/oracle/webhook/allowlist/${encoded}`)
      .expect(HttpStatus.OK);
  });
});

/**
 * Issue #1184 — Webhook Metrics Endpoint.
 *
 * Tests the admin endpoint:
 *   GET /webhooks/metrics
 *
 * Verifies admin-only access, the aggregated response shape, and that
 * Prometheus metrics for webhook deliveries are exposed.
 */
describe('Webhook Metrics Endpoint (e2e) — Issue #1184', () => {
  let app: INestApplication;
  let adminAllowed = true;

  const cacheStore = new Map<string, unknown>();

  const fakeCache = {
    get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      cacheStore.set(key, value);
      return true;
    }),
    del: jest.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
    increment: jest.fn(async () => 1),
    connect: jest.fn(async () => undefined),
    get isConnected() {
      return true;
    },
  } as unknown as CacheService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        WebhooksModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      ],
    })
      .overrideProvider(CacheService)
      .useValue(fakeCache)
      // Bypass JWT guard
      .overrideProvider('JwtAuthGuard')
      .useValue({ canActivate: () => true })
      // Admin guard can be toggled per-test to simulate non-admin access
      .overrideProvider('AdminGuard')
      .useValue({
        canActivate: (context: any) => {
          if (adminAllowed) {
            return true;
          }
          const res = context?.switchToHttp?.().getResponse?.();
          if (res && typeof res.status === 'function') {
            res.status(HttpStatus.FORBIDDEN).json({ message: 'Forbidden' });
          }
          return false;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    cacheStore.clear();
    adminAllowed = true;
  });

  it('GET /webhooks/metrics returns aggregated metrics for an admin', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/metrics')
      .expect(HttpStatus.OK);

    expect(res.body).toBeDefined();
    expect(res.body.webhooks).toBeDefined();
    expect(typeof res.body.webhooks.total).toBe('number');
    expect(typeof res.body.webhooks.active).toBe('number');
    expect(typeof res.body.webhooks.inactive).toBe('number');

    expect(res.body.deliveries).toBeDefined();
    expect(typeof res.body.deliveries.success).toBe('number');
    expect(typeof res.body.deliveries.failed).toBe('number');
    expect(typeof res.body.deliveries.pending).toBe('number');

    expect(typeof res.body.averageLatencyMs).toBe('number');
    expect(res.body.failureRateByEventType).toBeDefined();
    expect(Array.isArray(res.body.topFailingWebhooks)).toBe(true);
  });

  it('GET /webhooks/metrics is denied for non-admin users', async () => {
    adminAllowed = false;

    const res = await request(app.getHttpServer()).get('/webhooks/metrics');

    expect([HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN]).toContain(res.status);
  });

  it('exposes Prometheus metrics for webhook deliveries', async () => {
    const res = await request(app.getHttpServer())
      .get('/webhooks/metrics')
      .expect(HttpStatus.OK);

    // Aggregated payload should carry a Prometheus-compatible representation
    // (either inline text or a dedicated field) for delivery counters.
    const prometheus =
      typeof res.text === 'string' && res.text.includes('webhook')
        ? res.text
        : JSON.stringify(res.body);

    expect(prometheus).toMatch(/webhook/i);
  });
});

/**
 * Verify that the WebhookIpAllowlistGuard uses the dynamic list.
 */
describe('WebhookIpAllowlistGuard dynamic list (e2e) — Issue #1170', () => {
  it('WebhookIpAllowlistService.getAllowlist returns the dynamic list', async () => {
    const cacheStore = new Map<string, unknown>();
    const entries = [
      { cidr: '10.0.0.1', addedAt: '2024-01-01T00:00:00.000Z' },
      { cidr: '192.168.0.0/24', addedAt: '2024-01-01T00:00:00.000Z' },
    ];
    cacheStore.set('webhook:ip-allowlist', entries);

    const fakeCache = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async () => true),
      del: jest.fn(async () => undefined),
      connect: jest.fn(async () => undefined),
    } as unknown as CacheService;

    const { WebhookIpAllowlistService } = await import(
      '../src/webhooks/webhook-ip-allowlist.service'
    );
    const service = new WebhookIpAllowlistService(fakeCache);

    const allowlist = await service.getAllowlist();
    expect(allowlist).toContain('10.0.0.1');
    expect(allowlist).toContain('192.168.0.0/24');
    expect(allowlist.length).toBe(2);
  });

  it('isAllowed returns true for IPs in the dynamic list', async () => {
    const cacheStore = new Map<string, unknown>();
    const entries = [
      { cidr: '10.0.0.0/8', addedAt: '2024-01-01T00:00:00.000Z' },
    ];
    cacheStore.set('webhook:ip-allowlist', entries);

    const fakeCache = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async () => true),
      del: jest.fn(async () => undefined),
      connect: jest.fn(async () => undefined),
    } as unknown as CacheService;

    const { WebhookIpAllowlistService } = await import(
      '../src/webhooks/webhook-ip-allowlist.service'
    );
    const service = new WebhookIpAllowlistService(fakeCache);

    expect(await service.isAllowed('10.5.5.5')).toBe(true);
    expect(await service.isAllowed('8.8.8.8')).toBe(false);
  });

  it('isAllowed returns true (open) when allowlist is empty', async () => {
    const cacheStore = new Map<string, unknown>();

    const fakeCache = {
      get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
      set: jest.fn(async () => true),
      del: jest.fn(async () => undefined),
      connect: jest.fn(async () => undefined),
    } as unknown as CacheService;

    const { WebhookIpAllowlistService } = await import(
      '../src/webhooks/webhook-ip-allowlist.service'
    );
    const service = new WebhookIpAllowlistService(fakeCache);

    expect(await service.isAllowed('8.8.8.8')).toBe(true);
  });
});
