import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthModule } from '../src/auth/auth.module';
import { CacheModule } from '../src/common/cache.module';
import { CacheService } from '../src/common/cache.service';
import { buildJwtPayload } from '../src/auth/jwt-payload.util';

describe('Auth revocation (e2e)', () => {
  let app: INestApplication;
  let jwtService: JwtService;

  beforeAll(async () => {
    // In-memory CacheService so the issue #491 blocklist works without Redis.
    const revoked = new Map<string, boolean>();
    const fakeCache = {
      get: jest.fn(async (key: string) => revoked.get(key) ?? null),
      set: jest.fn(async (key: string, value: boolean) => {
        revoked.set(key, value);
        return true;
      }),
      del: jest.fn(async () => undefined),
      connect: jest.fn(async () => undefined),
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a token after it has been revoked', async () => {
    const payload = buildJwtPayload('GABCTESTACCOUNT');
    const token = jwtService.sign(payload);

    // POST /auth/logout is guarded by JwtAuthGuard — first call succeeds and
    // blocklists the token's jti (issue #491).
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(HttpStatus.OK);

    // The same token must now be rejected by JwtAuthGuard.
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(HttpStatus.UNAUTHORIZED);
  });
});
