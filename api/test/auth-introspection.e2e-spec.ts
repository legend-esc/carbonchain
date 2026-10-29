import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../src/auth/auth.module';
import { CacheModule } from '../src/common/cache.module';
import { CacheService } from '../src/common/cache.service';
import { AuthService } from '../src/auth/auth.service';
import { buildJwtPayload } from '../src/auth/jwt-payload.util';

/**
 * Issue #1172 — JWT Token Introspection endpoint.
 *
 * POST /auth/introspect returns token validity, claims, and type.
 * Access tokens are checked against the blocklist; refresh tokens are
 * checked against family revocation.
 */
describe('JWT Token Introspection (e2e) — Issue #1172', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let authService: AuthService;

  beforeAll(async () => {
    // In-memory cache for blocklist and refresh token storage
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
      mget: jest.fn(async (keys: string[]) =>
        keys.map((key) => cacheStore.get(key) ?? null),
      ),
      increment: jest.fn(async () => 1),
      connect: jest.fn(async () => undefined),
      get isConnected() {
        return true;
      },
    } as unknown as CacheService;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        AuthModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        CacheModule,
      ],
    })
      .overrideProvider(CacheService)
      .useValue(fakeCache)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    jwtService = moduleFixture.get(JwtService);
    authService = moduleFixture.get(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Access token introspection ─────────────────────────────────────────────

  it('POST /auth/introspect returns active=true for a valid access token', async () => {
    const payload = buildJwtPayload('GTESTACCOUNT123');
    const token = jwtService.sign(payload);

    const res = await request(app.getHttpServer())
      .post('/auth/introspect')
      .send({ token })
      .expect(HttpStatus.OK);

    expect(res.body.active).toBe(true);
    expect(res.body.account).toBe('GTESTACCOUNT123');
    expect(res.body.jti).toBe(payload.jti);
    expect(res.body.token_type).toBe('access');
    expect(res.body.exp).toBeDefined();
    expect(res.body.iat).toBeDefined();
  });

  it('POST /auth/introspect returns active=false for a blocklisted access token', async () => {
    const payload = buildJwtPayload('GBLOCKEDACCOUNT');
    const token = jwtService.sign(payload);

    // Revoke the token via logout (adds jti to blocklist)
    await authService.logout(token);

    const res = await request(app.getHttpServer())
      .post('/auth/introspect')
      .send({ token })
      .expect(HttpStatus.OK);

    expect(res.body.active).toBe(false);
    expect(res.body.token_type).toBe('access');
    expect(res.body.jti).toBe(payload.jti);
  });

  it('POST /auth/introspect returns active=false for an expired access token', async () => {
    // Sign a token that expired 1 hour ago
    const expiredPayload = {
      account: 'GEXPIRED',
      jti: 'expired-jti-uuid',
      iat: Math.floor(Date.now() / 1000) - 7200,
    };
    const token = jwtService.sign(expiredPayload, { expiresIn: '0s' });

    const res = await request(app.getHttpServer())
      .post('/auth/introspect')
      .send({ token })
      .expect(HttpStatus.OK);

    expect(res.body.active).toBe(false);
  });

  it('POST /auth/introspect returns active=false for an invalid JWT signature', async () => {
    const fakeToken =
      'eyJhbGciOiJIUzI1NiJ9.eyJhY2NvdW50IjoiR0ZBS0UifQ.invalid-signature';

    const res = await request(app.getHttpServer())
      .post('/auth/introspect')
      .send({ token: fakeToken })
      .expect(HttpStatus.OK);

    expect(res.body.active).toBe(false);
  });

  it('POST /auth/introspect returns active=false for a malformed token', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/introspect')
      .send({ token: 'not-a-jwt-or-uuid' })
      .expect(HttpStatus.OK);

    expect(res.body.active).toBe(false);
  });

  // ── Refresh token introspection ────────────────────────────────────────────

  it('POST /auth/introspect returns active=true for a valid refresh token', async () => {
    const tokenPair = await authService.issueTokenPair('GREFRESHTOKEN');

    const res = await request(app.getHttpServer())
      .post('/auth/introspect')
      .send({ token: tokenPair.refresh_token })
      .expect(HttpStatus.OK);

    expect(res.body.active).toBe(true);
    expect(res.body.account).toBe('GREFRESHTOKEN');
    expect(res.body.token_type).toBe('refresh');
  });

  it('POST /auth/introspect returns active=false for a non-existent refresh token', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/introspect')
      .send({ token: 'nonexistent-uuid-12345' })
      .expect(HttpStatus.OK);

    expect(res.body.active).toBe(false);
    expect(res.body.token_type).toBe('refresh');
  });

  it('POST /auth/introspect returns active=false for a revoked refresh token family', async () => {
    const tokenPair = await authService.issueTokenPair('GREVOKEDFAMILY');

    // Revoke by calling logout with the refresh token
    const accessPayload = buildJwtPayload('GREVOKEDFAMILY');
    const accessToken = jwtService.sign(accessPayload);
    await authService.logout(accessToken, tokenPair.refresh_token);

    const res = await request(app.getHttpServer())
      .post('/auth/introspect')
      .send({ token: tokenPair.refresh_token })
      .expect(HttpStatus.OK);

    expect(res.body.active).toBe(false);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────

  it('POST /auth/introspect is public (no auth required)', async () => {
    const payload = buildJwtPayload('GPUBLICTEST');
    const token = jwtService.sign(payload);

    await request(app.getHttpServer())
      .post('/auth/introspect')
      .send({ token })
      .expect(HttpStatus.OK);
  });
});
