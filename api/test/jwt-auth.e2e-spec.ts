import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

/**
 * Issue #36 — Verify that state-mutating endpoints reject unauthenticated callers.
 * These tests do NOT require a running Stellar node; they only check that the
 * JWT guard returns 401 before any service logic is reached.
 */
describe('JWT Auth Guard (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /credits/issue rejects unauthenticated request', () => {
    return request(app.getHttpServer())
      .post('/credits/issue')
      .send({
        issuerPublicKey: 'G...',
        projectId: 'P1',
        vintageYear: 2024,
        methodology: 'VCS',
        geography: 'NG',
        tonnes: '1000',
        ipfsHash: 'baf',
      })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('POST /retirement rejects unauthenticated request', () => {
    return request(app.getHttpServer())
      .post('/retirement')
      .send({
        buyerPublicKey: 'G...',
        creditId: 'abc',
        tonnes: '100',
        reason: 'test',
      })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('POST /marketplace/offer rejects unauthenticated request', () => {
    return request(app.getHttpServer())
      .post('/marketplace/offer')
      .send({
        sellerPublicKey: 'G...',
        creditId: 'abc',
        priceXlm: '1000',
        tonnes: '100',
      })
      .expect(HttpStatus.UNAUTHORIZED);
  });
});
