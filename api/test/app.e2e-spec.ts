import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { RetirementService } from './../src/retirement/retirement.service';
import { JwtAuthGuard } from './../src/auth/jwt-auth.guard';
import { ExecutionContext } from '@nestjs/common';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(() => app.close());

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/ (GET) returns an X-Request-ID header', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

describe('RetirementController batch_retire (e2e)', () => {
  let app: INestApplication<App>;

  const creditIds = ['aabbcc', 'ddeeff', '112233'];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(RetirementService)
      .useValue({
        retire: jest
          .fn()
          .mockImplementation((dto: { creditId: string }) =>
            Promise.resolve({ retirementId: `ret-${dto.creditId}` }),
          ),
        batchRetire: jest
          .fn()
          .mockImplementation((dtos: Array<{ creditId: string }>) =>
            Promise.resolve({
              retirementIds: dtos.map((d) => `ret-${d.creditId}`),
            }),
          ),
        getRetirement: jest.fn(),
        getRetirementsByAccount: jest.fn(),
      })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          // Inject a minimal user object so downstream code that reads
          // req.user doesn't throw, then allow the request through.
          const req = ctx.switchToHttp().getRequest<{ user?: unknown }>();
          req.user = { account: 'GTEST_E2E_ACCOUNT', isAdmin: false };
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(() => app.close());

  it('POST /retirement/batch retires 3 credits and returns all retirement IDs', async () => {
    const body = creditIds.map((id) => ({
      buyerPublicKey: 'GBUYERPUBLICKEY',
      creditId: id,
      tonnes: '1000000',
      reason: 'test offset',
    }));

    const { body: res } = await request(app.getHttpServer())
      .post('/retirement/batch')
      .send(body)
      .expect(201);

    expect(res.retirementIds).toHaveLength(3);
    expect(res.retirementIds).toEqual(creditIds.map((id) => `ret-${id}`));
  });
});
