import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import helmet from 'helmet';
import { AppModule } from '../src/app.module';
import { ThrottlerGuard } from '../src/common/throttler.guard';

/**
 * Issue #45  — Verify Helmet security headers and CORS are applied.
 * Issue #542 — Verify CORS origin whitelist enforcement (403 for non-whitelisted origins).
 * Issue #492 — Verify per-account rate limiting on POST /auth/verify.
 */
describe('Security Headers (e2e)', () => {
  let app: INestApplication;
  const allowedOrigins = ['http://localhost:4200'];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(helmet());
    app.enableCors({
      origin: (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
      ) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new ForbiddenException('Origin not allowed by CORS policy'));
        }
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
      maxAge: 86400,
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should set X-Content-Type-Options header', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('should set X-Frame-Options header (clickjacking protection)', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('should allow requests from the whitelisted frontend origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('should set a preflight cache (Access-Control-Max-Age: 86400)', async () => {
    const res = await request(app.getHttpServer())
      .options('/')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  it('should reject preflight requests from a non-whitelisted origin with 403', async () => {
    const res = await request(app.getHttpServer())
      .options('/')
      .set('Origin', 'http://evil.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'http://evil.example.com',
    );
  });

  it('should reject actual requests from a non-whitelisted origin with 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://evil.example.com');
    expect(res.status).toBe(HttpStatus.FORBIDDEN);
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'http://evil.example.com',
    );
  });
});

/**
 * Issue #492 — Per-account rate limiting on POST /auth/verify.
 *
 * These tests verify the ThrottlerGuard unit-level behaviour for account-
 * throttle mode without standing up a full HTTP server (to keep the suite
 * fast and free of Stellar/Redis dependencies).
 *
 * The e2e guard integration is validated via the unit spec in
 * throttler.guard.spec.ts; here we confirm the guard returns 429 after the
 * account limit is exhausted.
 */
describe('Per-account rate limiting (issue #492)', () => {
  it('ThrottlerGuard allows requests within accountLimit and blocks after', async () => {
    const { Reflector } = await import('@nestjs/core');
    const {
      ThrottlerGuard,
      ACCOUNT_THROTTLE_KEY,
    } = await import('../src/common/throttler.guard');
    const { HttpException, HttpStatus } = await import('@nestjs/common');

    const reflector = new Reflector();
    const guard = new ThrottlerGuard(reflector);

    const opts = { accountLimit: 3, ipLimit: 50, ttl: 300_000 };

    jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
      if (key === ACCOUNT_THROTTLE_KEY) return opts;
      return undefined;
    });

    const makeCtx = () => {
      const mockReq = {
        headers: {},
        socket: { remoteAddress: '1.2.3.4' },
        path: '/auth/verify',
        body: { account: 'GTEST_ACCOUNT_PER_ISSUE_492' },
      };
      return {
        switchToHttp: () => ({
          getRequest: () => mockReq,
          getResponse: () => ({ set: jest.fn() }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as any;
    };

    // First 3 requests succeed.
    await expect(guard.canActivate(makeCtx())).resolves.toBe(true);
    await expect(guard.canActivate(makeCtx())).resolves.toBe(true);
    await expect(guard.canActivate(makeCtx())).resolves.toBe(true);

    // 4th request exceeds the accountLimit and returns 429.
    await expect(guard.canActivate(makeCtx())).rejects.toThrow(HttpException);
  });

  it('IP and account limits are independent — different accounts share the same IP limit', async () => {
    const { Reflector } = await import('@nestjs/core');
    const { ThrottlerGuard, ACCOUNT_THROTTLE_KEY } = await import(
      '../src/common/throttler.guard'
    );
    const { HttpException } = await import('@nestjs/common');

    const reflector = new Reflector();
    const guard = new ThrottlerGuard(reflector);

    // Low IP limit to verify it blocks even when accounts rotate
    const opts = { accountLimit: 100, ipLimit: 2, ttl: 300_000 };

    jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
      if (key === ACCOUNT_THROTTLE_KEY) return opts;
      return undefined;
    });

    let accountIdx = 0;
    const makeCtxWithNewAccount = () => {
      accountIdx++;
      const mockReq = {
        headers: {},
        socket: { remoteAddress: '5.5.5.5' },
        path: '/auth/verify',
        body: { account: `GACCOUNT${accountIdx}` },
      };
      return {
        switchToHttp: () => ({
          getRequest: () => mockReq,
          getResponse: () => ({ set: jest.fn() }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as any;
    };

    // First 2 requests from this IP succeed (different accounts each time).
    await expect(guard.canActivate(makeCtxWithNewAccount())).resolves.toBe(true);
    await expect(guard.canActivate(makeCtxWithNewAccount())).resolves.toBe(true);

    // 3rd request is blocked by the IP limit even though it uses a fresh account.
    await expect(guard.canActivate(makeCtxWithNewAccount())).rejects.toThrow(
      HttpException,
    );
  });
});
