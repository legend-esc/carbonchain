import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { AuthModule } from '../src/auth/auth.module';
import { TokenRevocationService } from '../src/auth/token-revocation.service';
import { buildJwtPayload } from '../src/auth/jwt-payload.util';

describe('Auth revocation (e2e)', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let revocation: TokenRevocationService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    jwtService = moduleFixture.get(JwtService);
    revocation = moduleFixture.get(TokenRevocationService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a token after it has been revoked', async () => {
    const payload = buildJwtPayload('GABCTESTACCOUNT');
    const token = jwtService.sign(payload);

    // Sanity check: token is valid before revocation.
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await revocation.revoke(payload.jti, 3600);

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });
});
