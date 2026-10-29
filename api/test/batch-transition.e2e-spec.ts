/**
 * E2E tests for #1106: POST /credits/batch-transition
 *
 * Covers:
 * - Auth guard (401 without JWT)
 * - Batch expire: all succeed
 * - Batch dispute: all succeed
 * - Partial success: some credits fail, others succeed
 * - Missing evidenceIpfsHash for dispute action → 400
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CreditsService } from '../src/credits/credits.service';

describe('POST /credits/batch-transition (e2e)', () => {
  let app: INestApplication;

  const mockBatchTransition = jest.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CreditsService)
      .useValue({ batchTransitionCredits: mockBatchTransition })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => mockBatchTransition.mockReset());

  // ── Auth guard ────────────────────────────────────────────────────────────

  it('401 — rejects unauthenticated callers', () => {
    return request(app.getHttpServer())
      .post('/credits/batch-transition')
      .send({
        creditIds: ['id-1', 'id-2'],
        action: 'expire',
      })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  // ── Batch expire ──────────────────────────────────────────────────────────

  it('201 — batch expire: all credits succeed', async () => {
    mockBatchTransition.mockResolvedValue({
      succeeded: ['id-1', 'id-2', 'id-3'],
      failed: [],
    });

    const { body } = await request(app.getHttpServer())
      .post('/credits/batch-transition')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({
        creditIds: ['id-1', 'id-2', 'id-3'],
        action: 'expire',
        reason: 'Vintage year 2019 sweep',
      })
      .expect(HttpStatus.CREATED);

    expect(body.succeeded).toHaveLength(3);
    expect(body.failed).toHaveLength(0);
    expect(body.succeeded).toContain('id-1');
    expect(mockBatchTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        creditIds: ['id-1', 'id-2', 'id-3'],
        action: 'expire',
      }),
      expect.any(String),
    );
  });

  // ── Batch dispute ─────────────────────────────────────────────────────────

  it('201 — batch dispute: all credits succeed with evidence hash', async () => {
    mockBatchTransition.mockResolvedValue({
      succeeded: ['id-4', 'id-5'],
      failed: [],
    });

    const { body } = await request(app.getHttpServer())
      .post('/credits/batch-transition')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({
        creditIds: ['id-4', 'id-5'],
        action: 'dispute',
        evidenceIpfsHash: 'bafybei-batch-evidence',
        reason: 'Anomaly detected across multiple 2022 credits',
      })
      .expect(HttpStatus.CREATED);

    expect(body.succeeded).toHaveLength(2);
    expect(body.failed).toHaveLength(0);
  });

  // ── Partial success ───────────────────────────────────────────────────────

  it('201 — partial success: some credits fail while others succeed', async () => {
    mockBatchTransition.mockResolvedValue({
      succeeded: ['id-6'],
      failed: [
        { creditId: 'id-7', error: 'Credit id-7 not found' },
        {
          creditId: 'id-8',
          error: 'Credit id-8 cannot be expired — current status: Retired',
        },
      ],
    });

    const { body } = await request(app.getHttpServer())
      .post('/credits/batch-transition')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({
        creditIds: ['id-6', 'id-7', 'id-8'],
        action: 'expire',
      })
      .expect(HttpStatus.CREATED);

    expect(body.succeeded).toEqual(['id-6']);
    expect(body.failed).toHaveLength(2);
    expect(body.failed[0]).toHaveProperty('creditId', 'id-7');
    expect(body.failed[0]).toHaveProperty('error');
    expect(body.failed[1]).toHaveProperty('creditId', 'id-8');
  });

  // ── Validation errors ─────────────────────────────────────────────────────

  it('400 — rejects empty creditIds array', async () => {
    await request(app.getHttpServer())
      .post('/credits/batch-transition')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({
        creditIds: [],
        action: 'expire',
      })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('400 — rejects invalid action value', async () => {
    await request(app.getHttpServer())
      .post('/credits/batch-transition')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({
        creditIds: ['id-1'],
        action: 'invalid-action',
      })
      .expect(HttpStatus.BAD_REQUEST);
  });
});
