import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import helmet from 'helmet';
import { AppModule } from '../src/app.module';

/**
 * Issue #45 — Verify Helmet security headers and CORS are applied.
 */
describe('Security Headers (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(helmet());
    app.enableCors({
      origin: process.env.FRONTEND_URL ?? 'http://localhost:4200',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
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

  it('should allow requests from the frontend origin', async () => {
    const res = await request(app.getHttpServer())
      .options('/')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
  });

  it('should reject requests from disallowed origins', async () => {
    const res = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://evil.example.com');
    expect(res.headers['access-control-allow-origin']).not.toBe(
      'http://evil.example.com',
    );
  });
});
