import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ExecutionContext,
  CanActivate,
  UnauthorizedException,
} from '@nestjs/common';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { CacheService } from '../src/common/cache.service';
import { StellarKeypairService } from '../src/stellar/stellar-keypair.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AdminGuard } from '../src/admin/admin.guard';

/**
 * In-memory fake CacheService used by the e2e tests.
 * Stores arbitrary values (not just strings) to match the behaviour of the
 * real CacheService which JSON-serialises/deserialises on get/set.
 * Implements the full subset used by AuthService.
 */
class InMemoryCacheService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private store = new Map<string, any>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async get<T = any>(key: string): Promise<T | null> {
    return this.store.has(key) ? (this.store.get(key) as T) : null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async set(key: string, value: any, _ttl?: number): Promise<boolean> {
    this.store.set(key, value);
    return true;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async mget<T = any>(keys: string[]): Promise<(T | null)[]> {
    return keys.map((key) =>
      this.store.has(key) ? (this.store.get(key) as T) : null,
    );
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const regex = new RegExp(
      '^' +
        pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
        '$',
    );
    return Array.from(this.store.keys()).filter((key) => regex.test(key));
  }

  async ttl(_key: string): Promise<number> {
    return -1;
  }

  async reset(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Fake JWT guard that reads the user from the `x-test-user` header.
 * Throws UnauthorizedException when the header is absent so NestJS returns 401.
 */
class FakeJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const account = req.headers['x-test-user'];
    if (!account) {
      throw new UnauthorizedException();
    }
    req.user = {
      account,
      sub: account,
      role: req.headers['x-test-role'] ?? 'user',
    };
    return true;
  }
}

/**
 * Fake admin guard: allows access only when `req.user.role === 'admin'`.
 */
class FakeAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    return req.user?.role === 'admin';
  }
}

describe('Auth Sessions & Batch Revocation (e2e)', () => {
  let app: INestApplication;
  let authService: AuthService;
  let cache: InMemoryCacheService;

  const account = 'user@example.com';
  const userAgent = 'jest-e2e-agent/1.0';
  const ip = '127.0.0.1';

  beforeAll(async () => {
    cache = new InMemoryCacheService();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: CacheService, useValue: cache },
        {
          provide: JwtService,
          useValue: {
            sign: jest
              .fn()
              .mockImplementation(
                (payload: Record<string, unknown>) =>
                  `mock.jwt.${JSON.stringify(payload)}`,
              ),
            verify: jest.fn().mockReturnValue({ sub: account }),
            decode: jest.fn().mockReturnValue({ sub: account }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(
              (_key: string, defaultValue?: unknown) => defaultValue,
            ),
          },
        },
        {
          provide: StellarKeypairService,
          useValue: {
            getAdminKeypair: jest.fn(() => ({ publicKey: () => 'GADMIN' })),
            getAdminPublicKey: jest.fn(() => 'GADMIN'),
          },
        },
        Reflector,
        JwtAuthGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(FakeJwtAuthGuard)
      .overrideGuard(AdminGuard)
      .useClass(FakeAdminGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    authService = moduleFixture.get<AuthService>(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cache.reset();
  });

  describe('GET /auth/sessions', () => {
    it('returns active sessions with device metadata', async () => {
      await authService.issueTokenPair(account, undefined, { userAgent, ip });

      const res = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set('x-test-user', account)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);

      const session = res.body[0];
      expect(session.familyId).toBeDefined();
      expect(session.userAgent).toBe(userAgent);
      expect(session.ip).toBe(ip);
      expect(session.createdAt).toBeDefined();
      expect(session.lastUsedAt).toBeDefined();
    });

    it('returns 401 without authentication', async () => {
      await request(app.getHttpServer()).get('/auth/sessions').expect(401);
    });

    it('only returns sessions for the authenticated account', async () => {
      await authService.issueTokenPair(account, undefined, { userAgent, ip });
      await authService.issueTokenPair('other@example.com', undefined, {
        userAgent: 'other-agent',
        ip: '10.0.0.1',
      });

      const res = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set('x-test-user', account)
        .expect(200);

      expect(res.body.length).toBe(1);
      expect(res.body[0].userAgent).toBe(userAgent);
    });
  });

  describe('DELETE /auth/sessions/:familyId', () => {
    it('revokes the session and subsequent refresh fails', async () => {
      const pair = await authService.issueTokenPair(account, undefined, {
        userAgent,
        ip,
      });

      const sessions = await authService.getActiveSessions(account);
      expect(sessions.length).toBe(1);
      const familyId = sessions[0].familyId;

      await request(app.getHttpServer())
        .delete(`/auth/sessions/${familyId}`)
        .set('x-test-user', account)
        .expect(200);

      const after = await authService.getActiveSessions(account);
      expect(after.length).toBe(0);

      await expect(
        authService.rotateRefreshToken(pair.refresh_token, { userAgent, ip }),
      ).rejects.toBeDefined();
    });

    it('returns 401 without authentication', async () => {
      await request(app.getHttpServer())
        .delete('/auth/sessions/some-family-id')
        .expect(401);
    });
  });

  describe('rotateRefreshToken', () => {
    it('updates lastUsedAt on rotation', async () => {
      const pair = await authService.issueTokenPair(account, undefined, {
        userAgent,
        ip,
      });

      // Verify the refresh token was actually stored in the mock cache.
      const storedToken = await cache.get(
        `auth:refresh:token:${pair.refresh_token}`,
      );
      expect(storedToken).not.toBeNull();

      const before = await authService.getActiveSessions(account);
      expect(before.length).toBe(1);
      const initialLastUsedAt = before[0].lastUsedAt;

      // Ensure a measurable time difference.
      await new Promise((resolve) => setTimeout(resolve, 10));

      await authService.rotateRefreshToken(pair.refresh_token, {
        userAgent,
        ip,
      });

      const after = await authService.getActiveSessions(account);
      expect(after.length).toBe(1);
      expect(new Date(after[0].lastUsedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(initialLastUsedAt).getTime(),
      );
      expect(after[0].lastUsedAt).not.toBe(initialLastUsedAt);
    });
  });

  describe('POST /auth/revocation/check', () => {
    it('returns correct revoked flags for a mix of blocklisted and valid JTIs', async () => {
      const revokedJti = 'revoked-jti-1';
      const validJti = 'valid-jti-1';

      await authService.revokeToken(revokedJti);

      const res = await request(app.getHttpServer())
        .post('/auth/revocation/check')
        .set('x-test-user', 'admin@example.com')
        .set('x-test-role', 'admin')
        .send({ jtis: [revokedJti, validJti] })
        .expect(201);

      expect(res.body.results).toBeDefined();
      expect(Array.isArray(res.body.results)).toBe(true);
      expect(res.body.results.length).toBe(2);

      const revokedResult = res.body.results.find(
        (r: { jti: string }) => r.jti === revokedJti,
      );
      const validResult = res.body.results.find(
        (r: { jti: string }) => r.jti === validJti,
      );

      expect(revokedResult.revoked).toBe(true);
      expect(validResult.revoked).toBe(false);
    });

    it('returns 403 for non-admin users', async () => {
      await request(app.getHttpServer())
        .post('/auth/revocation/check')
        .set('x-test-user', account)
        .set('x-test-role', 'user')
        .send({ jtis: ['some-jti'] })
        .expect(403);
    });

    it('returns 401 without authentication', async () => {
      await request(app.getHttpServer())
        .post('/auth/revocation/check')
        .send({ jtis: ['some-jti'] })
        .expect(401);
    });
  });
});
