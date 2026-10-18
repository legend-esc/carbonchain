import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Issue #189 — X-Request-ID is generated when absent and echoed back when supplied.
 */
describe('Request ID propagation (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  it('generates an X-Request-ID when the client does not send one', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('echoes back a client-supplied X-Request-ID', async () => {
    const res = await request(app.getHttpServer())
      .get('/')
      .set('X-Request-ID', 'caller-supplied-id')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('caller-supplied-id');
  });

  it('assigns distinct generated ids to consecutive requests', async () => {
    const first = await request(app.getHttpServer()).get('/').expect(200);
    const second = await request(app.getHttpServer()).get('/').expect(200);

    const firstId = first.headers['x-request-id'];
    const secondId = second.headers['x-request-id'];

    expect(firstId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(secondId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(firstId).not.toBe(secondId);
  });
});