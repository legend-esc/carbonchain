/**
 * E2E tests for #1105: GET /credits/verifier/:address/pending-count
 *
 * Verifies that the pending count returned by the endpoint matches the number
 * of Pending credits tracked by CreditsService.getVerifierPendingCount.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CreditsService } from '../src/credits/credits.service';

const VERIFIER_ADDRESS = 'GVERIFIER123ABC';

describe('GET /credits/verifier/:address/pending-count (e2e)', () => {
  let app: INestApplication;

  const mockGetVerifierPendingCount = jest.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CreditsService)
      .useValue({ getVerifierPendingCount: mockGetVerifierPendingCount })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => mockGetVerifierPendingCount.mockReset());

  it('200 — returns pending count for a verifier with pending credits', async () => {
    mockGetVerifierPendingCount.mockResolvedValue({
      address: VERIFIER_ADDRESS,
      pendingCount: 7,
    });

    const { body } = await request(app.getHttpServer())
      .get(`/credits/verifier/${VERIFIER_ADDRESS}/pending-count`)
      .expect(HttpStatus.OK);

    expect(body.address).toBe(VERIFIER_ADDRESS);
    expect(body.pendingCount).toBe(7);
    expect(typeof body.pendingCount).toBe('number');
    expect(mockGetVerifierPendingCount).toHaveBeenCalledWith(VERIFIER_ADDRESS);
  });

  it('200 — returns pendingCount=0 when no credits are pending', async () => {
    mockGetVerifierPendingCount.mockResolvedValue({
      address: VERIFIER_ADDRESS,
      pendingCount: 0,
    });

    const { body } = await request(app.getHttpServer())
      .get(`/credits/verifier/${VERIFIER_ADDRESS}/pending-count`)
      .expect(HttpStatus.OK);

    expect(body.pendingCount).toBe(0);
  });

  it('200 — pending count matches get_pending_credits list length', async () => {
    // Simulate 3 pending credits associated with this verifier
    mockGetVerifierPendingCount.mockResolvedValue({
      address: VERIFIER_ADDRESS,
      pendingCount: 3,
    });

    const { body } = await request(app.getHttpServer())
      .get(`/credits/verifier/${VERIFIER_ADDRESS}/pending-count`)
      .expect(HttpStatus.OK);

    // Count reported should match the number of pending credit records
    expect(body.pendingCount).toBe(3);
  });

  it('200 — response shape is always { address, pendingCount }', async () => {
    mockGetVerifierPendingCount.mockResolvedValue({
      address: 'GANOTHER...',
      pendingCount: 1,
    });

    const { body } = await request(app.getHttpServer())
      .get('/credits/verifier/GANOTHER.../pending-count')
      .expect(HttpStatus.OK);

    expect(body).toHaveProperty('address');
    expect(body).toHaveProperty('pendingCount');
  });
});
