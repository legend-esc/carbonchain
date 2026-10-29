import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ExecutionContext,
  CanActivate,
} from '@nestjs/common';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module';
import { AuthService } from '../src/auth/auth.service';
import { CacheModule } from '../src/common/cache.module';
import { CacheService } from '../src/common/cache.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AdminGuard } from '../src/admin/admin.guard';
import { ConfigModule } from '@nestjs/config';

/**
 * In-memory fake CacheService used by the e2e tests.
 * Implements the subset of CacheService used by AuthService, including
 * `mget` and `scanKeys` needed for batch revocation checks and session listing.
 */
class InMemoryCacheService {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  async set(key: string, value: string, _ttl?: number): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((key) =>
      this.store.has(key) ? (this.store.get(key) as string) : null,
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

  async reset(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Fake JWT guard that reads the user from the `x-test-user` header.
 * Allows tests to simulate authenticated users without issuing real JWTs.
 */
class FakeJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const account = req.headers['x-test-user'];
    if (!account) {
      return false;
    }
    req.user = {
      account,
      sub: account,
      role: req.headers['x-test-role'] || 'user',
    };
    return true;
  }
}

/**
 * Fake admin guard that checks the `x-test-role` header.
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
      imports: [
        AuthModule,
        CacheModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      ],
    })
      .overrideProvider(CacheService)
      .useValue(cache)
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
      await authService.issueTokenPair(account, { userAgent, ip });

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
      await authService.issueTokenPair(account, { userAgent, ip });
      await authService.issueTokenPair('other@example.com', {
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
      const pair = await authService.issueTokenPair(account, { userAgent, ip });

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
        authService.rotateRefreshToken(pair.refreshToken, { userAgent, ip }),
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
      const pair = await authService.issueTokenPair(account, { userAgent, ip });

      const before = await authService.getActiveSessions(account);
      expect(before.length).toBe(1);
      const initialLastUsedAt = before[0].lastUsedAt;

      // Ensure a measurable time difference.
      await new Promise((resolve) => setTimeout(resolve, 10));

      await authService.rotateRefreshToken(pair.refreshToken, {
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
