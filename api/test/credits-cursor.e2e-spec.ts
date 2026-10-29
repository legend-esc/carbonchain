/**
 * #1098 — Cursor pagination e2e tests for the Credits list endpoint.
 *
 * Tests cover:
 *  1. First page without cursor returns data + next_cursor
 *  2. Second page with cursor returns correct next page
 *  3. Cursor past end returns empty data + null cursor
 *  4. Limit capped at 100
 *  5. Filter by methodology works with cursor
 *  6. Filter by geography works with cursor
 *  7. Filter by vintage_year works with cursor
 *  8. Filter by status works with cursor
 *  9. Empty result when no credits match filter
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { StellarService } from './../src/stellar/stellar.service';
import type { ICreditRepository } from './../src/credits/credit.repository';
import { CREDIT_REPOSITORY } from './../src/credits/credit.repository';
import { JwtAuthGuard } from './../src/auth/jwt-auth.guard';
import { CreditStatus } from '../../shared';

const TEST_ACCOUNT = 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { account: string } }>();
    req.user = { account: TEST_ACCOUNT };
    return true;
  }
}

describe('Credits cursor pagination (e2e)', () => {
  let app: INestApplication<App>;
  let creditRepo: ICreditRepository;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StellarService)
      .useValue({
        invokeContract: jest.fn().mockImplementation((_id, method) => {
          if (method === 'submit_credit') {
            const id = Buffer.alloc(32);
            id.write(`credit-${Date.now()}-${Math.random()}`);
            return Promise.resolve({
              returnValue: {
                type: 'bytes',
                value: id,
              },
            });
          }
          return Promise.resolve({ returnValue: null });
        }),
        readContract: jest.fn(),
        getContractEvents: jest.fn().mockResolvedValue([]),
      })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    creditRepo = moduleFixture.get(CREDIT_REPOSITORY);

    // Seed the in-memory repository with enough credits for pagination tests.
    // We create 5 VCS/NG/2024 + 3 CDM/US/2023 + 2 REDD+/BR/2022 credits.
    await seedCredits(creditRepo);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Test 1: First page without cursor ──────────────────────────────────────

  it('1. first page without cursor returns data + next_cursor', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/credits')
      .query({ cursor: '', limit: '3' })
      .expect(200);

    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(3);
    expect(body.pagination_mode).toBe('cursor');
    // With 10 seeded credits and limit=3, we expect a next_cursor
    if (body.data.length === 3) {
      expect(body.next_cursor).not.toBeNull();
      expect(typeof body.next_cursor).toBe('string');
    }
  });

  // ── Test 2: Second page with cursor ──────────────────────────────────────

  it('2. second page with cursor returns correct next page', async () => {
    // Get first page
    const first = await request(app.getHttpServer())
      .get('/credits')
      .query({ cursor: '', limit: '3' })
      .expect(200);

    expect(first.body.next_cursor).not.toBeNull();
    const cursor = first.body.next_cursor as string;
    const firstIds = first.body.data.map(
      (c: { id: string }) => c.id,
    ) as string[];

    // Get second page using cursor
    const second = await request(app.getHttpServer())
      .get('/credits')
      .query({ cursor, limit: '3' })
      .expect(200);

    expect(second.body.data).toBeDefined();
    expect(Array.isArray(second.body.data)).toBe(true);
    expect(second.body.pagination_mode).toBe('cursor');

    // Second page must not contain any IDs from first page
    const secondIds = second.body.data.map(
      (c: { id: string }) => c.id,
    ) as string[];
    const overlap = secondIds.filter((id) => firstIds.includes(id));
    expect(overlap).toHaveLength(0);
  });

  // ── Test 3: Cursor past end returns empty data + null cursor ──────────────

  it('3. cursor past end returns empty data + null cursor', async () => {
    // Exhaust all pages by paginating until next_cursor is null
    let cursor: string = '';
    let iterations = 0;
    const maxIterations = 20;

    while (iterations < maxIterations) {
      const { body } = await request(app.getHttpServer())
        .get('/credits')
        .query({ cursor, limit: '3' })
        .expect(200);

      if (body.next_cursor === null || body.data.length === 0) {
        // Reached the end — verify null cursor and empty (or last) data
        expect(body.next_cursor).toBeNull();
        break;
      }
      cursor = body.next_cursor as string;
      iterations++;
    }
    // We must have exited via the null cursor path
    expect(iterations).toBeLessThan(maxIterations);
  });

  // ── Test 4: Limit capped at 100 ───────────────────────────────────────────

  it('4. limit is capped at 100', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/credits')
      .query({ cursor: '', limit: '9999' })
      .expect(200);

    expect(body.data).toBeDefined();
    expect(body.pagination_mode).toBe('cursor');
    // The service caps at 100 — even with 9999 requested, we get at most 100
    expect(body.data.length).toBeLessThanOrEqual(100);
    // limit field in response should reflect capped value
    expect(body.limit).toBeLessThanOrEqual(100);
  });

  // ── Test 5: Filter by methodology works with cursor ───────────────────────

  it('5. filter by methodology returns only matching credits', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/credits')
      .query({ cursor: '', limit: '20', methodology: 'VCS' })
      .expect(200);

    expect(body.data).toBeDefined();
    expect(body.pagination_mode).toBe('cursor');
    // All returned credits must have methodology === 'VCS'
    for (const credit of body.data as Array<{ methodology: string }>) {
      expect(credit.methodology).toBe('VCS');
    }
  });

  // ── Test 6: Filter by geography works with cursor ─────────────────────────

  it('6. filter by geography returns only matching credits', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/credits')
      .query({ cursor: '', limit: '20', geography: 'NG' })
      .expect(200);

    expect(body.data).toBeDefined();
    expect(body.pagination_mode).toBe('cursor');
    for (const credit of body.data as Array<{ geography: string }>) {
      expect(credit.geography.toUpperCase()).toBe('NG');
    }
  });

  // ── Test 7: Filter by vintage_year works with cursor ──────────────────────

  it('7. filter by vintage_year returns only matching credits', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/credits')
      .query({ cursor: '', limit: '20', vintage_year: '2023' })
      .expect(200);

    expect(body.data).toBeDefined();
    expect(body.pagination_mode).toBe('cursor');
    for (const credit of body.data as Array<{ vintage_year: number }>) {
      expect(credit.vintage_year).toBe(2023);
    }
  });

  // ── Test 8: Filter by status works with cursor ────────────────────────────

  it('8. filter by status returns only matching credits', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/credits')
      .query({ cursor: '', limit: '20', status: 'Active' })
      .expect(200);

    expect(body.data).toBeDefined();
    expect(body.pagination_mode).toBe('cursor');
    for (const credit of body.data as Array<{ status: string }>) {
      expect(credit.status).toBe('Active');
    }
  });

  // ── Test 9: Empty result when no credits match filter ─────────────────────

  it('9. returns empty data and null cursor when no credits match filter', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/credits')
      .query({
        cursor: '',
        limit: '20',
        methodology: 'NONEXISTENT_METHODOLOGY_XYZ',
      })
      .expect(200);

    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
    expect(body.next_cursor).toBeNull();
    expect(body.pagination_mode).toBe('cursor');
  });
});

// ── Seed helper ───────────────────────────────────────────────────────────────

async function seedCredits(repo: ICreditRepository): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  const credits = [
    // 5 VCS / NG / 2024 / Active
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `vcs-ng-${i + 1}`,
      projectId: 'PROJ-001',
      issuer: TEST_ACCOUNT,
      owner: TEST_ACCOUNT,
      vintageYear: 2024,
      methodology: 'VCS',
      geography: 'NG',
      tonnes: '1000000',
      ipfsHash: `bafybei-vcs-ng-${i + 1}`,
      status: CreditStatus.Active,
      issuedAt: now + i,
    })),
    // 3 CDM / US / 2023 / Active
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `cdm-us-${i + 1}`,
      projectId: 'PROJ-002',
      issuer: TEST_ACCOUNT,
      owner: TEST_ACCOUNT,
      vintageYear: 2023,
      methodology: 'CDM',
      geography: 'US',
      tonnes: '500000',
      ipfsHash: `bafybei-cdm-us-${i + 1}`,
      status: CreditStatus.Active,
      issuedAt: now + 10 + i,
    })),
    // 2 REDD+ / BR / 2022 / Active
    ...Array.from({ length: 2 }, (_, i) => ({
      id: `redd-br-${i + 1}`,
      projectId: 'PROJ-003',
      issuer: TEST_ACCOUNT,
      owner: TEST_ACCOUNT,
      vintageYear: 2022,
      methodology: 'REDD+',
      geography: 'BR',
      tonnes: '200000',
      ipfsHash: `bafybei-redd-br-${i + 1}`,
      status: CreditStatus.Active,
      issuedAt: now + 20 + i,
    })),
  ];

  for (const c of credits) {
    await repo.save(c);
  }
}
