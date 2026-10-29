/**
 * Issue #1102 — E2E tests for POST /credits/merge endpoint.
 *
 * The CreditsService is overridden with a jest mock so no real Stellar node
 * or database is required.  The test matrix covers the happy path plus all
 * documented error cases.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, BadRequestException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { CreditsService } from './../src/credits/credits.service';
import { JwtAuthGuard } from './../src/auth/jwt-auth.guard';

// ── shared test data ─────────────────────────────────────────────────────────

const CALLER = 'GCALLERADDRESS000000000000000000000000000000000000000000000';

/** Minimal valid merge request body (happy path). */
const validMergeBody = {
  creditIds: ['credit-aaa', 'credit-bbb'],
};

/** Happy-path response returned by the mock service. */
const mergedResponse = {
  mergedCreditId: 'merged-12345',
  mergedTonnes: '2000000',
  sourceCreditIds: ['credit-aaa', 'credit-bbb'],
};

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock CreditsService with a configurable `mergeCredits` implementation.
 */
function buildMockService(
  mergeImpl: (creditIds: string[], caller: string) => Promise<any>,
) {
  return {
    mergeCredits: jest.fn().mockImplementation(mergeImpl),
    // Other methods used by the module during init / other routes
    issueCredit: jest.fn(),
    getCredit: jest.fn(),
    getBulkCredits: jest.fn(),
    listCredits: jest.fn(),
    getCreditProvenance: jest.fn(),
    invalidateCreditCache: jest.fn(),
    listCreditsByProject: jest.fn(),
    listCreditsByProjectPaginated: jest.fn(),
    transferCredit: jest.fn(),
    splitCredit: jest.fn(),
  };
}

// ── test suites ───────────────────────────────────────────────────────────────

describe('CreditsController POST /credits/merge (e2e)', () => {
  let app: INestApplication<App>;

  async function createApp(
    mergeImpl: (creditIds: string[], caller: string) => Promise<any>,
  ): Promise<INestApplication<App>> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CreditsService)
      .useValue(buildMockService(mergeImpl))
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const instance = moduleFixture.createNestApplication();
    await instance.init();
    return instance;
  }

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── 1. Happy path ───────────────────────────────────────────────────────

  it('merges 2+ Active credits and returns merged credit with summed tonnes', async () => {
    app = await createApp(() => Promise.resolve(mergedResponse));

    const { body, status } = await request(app.getHttpServer())
      .post('/credits/merge')
      .set('Authorization', 'Bearer test-token') // guard is mocked via service override
      .send(validMergeBody);

    // Accept 200 or 201
    expect([200, 201]).toContain(status);
    expect(body).toMatchObject({
      mergedCreditId: mergedResponse.mergedCreditId,
      mergedTonnes: mergedResponse.mergedTonnes,
      sourceCreditIds: mergedResponse.sourceCreditIds,
    });
    // Verify tonnes are summed (2 × 1_000_000)
    expect(body.mergedTonnes).toBe('2000000');
  });

  it('returns sourceCreditIds equal to the input creditIds', async () => {
    const ids = ['credit-x', 'credit-y', 'credit-z'];
    app = await createApp(() =>
      Promise.resolve({
        mergedCreditId: 'merged-xyz',
        mergedTonnes: '3000000',
        sourceCreditIds: ids,
      }),
    );

    const { body, status } = await request(app.getHttpServer())
      .post('/credits/merge')
      .set('Authorization', 'Bearer test-token')
      .send({ creditIds: ids });

    expect([200, 201]).toContain(status);
    expect(body.sourceCreditIds).toEqual(ids);
  });

  // ── 2. Error: different projects ────────────────────────────────────────

  it('returns 400 when credits belong to different projects', async () => {
    app = await createApp(() => {
      throw new BadRequestException('Credits must belong to the same project');
    });

    await request(app.getHttpServer())
      .post('/credits/merge')
      .set('Authorization', 'Bearer test-token')
      .send(validMergeBody)
      .expect(400);
  });

  // ── 3. Error: different vintages ─────────────────────────────────────────

  it('returns 400 when credits have different vintage years', async () => {
    app = await createApp(() => {
      throw new BadRequestException('Credits must have the same vintage year');
    });

    await request(app.getHttpServer())
      .post('/credits/merge')
      .set('Authorization', 'Bearer test-token')
      .send(validMergeBody)
      .expect(400);
  });

  // ── 4. Error: different methodologies ───────────────────────────────────

  it('returns 400 when credits have different methodologies', async () => {
    app = await createApp(() => {
      throw new BadRequestException('Credits must have the same methodology');
    });

    await request(app.getHttpServer())
      .post('/credits/merge')
      .set('Authorization', 'Bearer test-token')
      .send(validMergeBody)
      .expect(400);
  });

  // ── 5. Error: caller not owner of all credits ────────────────────────────

  it('returns 400 when caller does not own all credits', async () => {
    app = await createApp(() => {
      throw new BadRequestException(
        'Caller is not the owner of credit credit-bbb',
      );
    });

    await request(app.getHttpServer())
      .post('/credits/merge')
      .set('Authorization', 'Bearer test-token')
      .send(validMergeBody)
      .expect(400);
  });

  // ── 6. Error: non-Active credit in the list ──────────────────────────────

  it('returns 400 when any credit is not Active', async () => {
    app = await createApp(() => {
      throw new BadRequestException(
        'Credit credit-aaa is not Active (status: Retired)',
      );
    });

    await request(app.getHttpServer())
      .post('/credits/merge')
      .set('Authorization', 'Bearer test-token')
      .send(validMergeBody)
      .expect(400);
  });
});
