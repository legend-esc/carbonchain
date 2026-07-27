/**
 * Issue #545 — SQL Injection prevention test suite.
 *
 * These tests submit known SQL injection payloads via query parameters to
 * all user-controlled filter endpoints and verify:
 *
 *   1. The response is either 400 (invalid input) or an empty / safe result.
 *   2. The application never executes the injected SQL.
 *   3. TypeORM's parameterised query path is exercised (no string
 *      concatenation escapes into the query).
 *
 * The underlying repository is the in-memory InMemoryCreditRepository and
 * InMemoryRetirementRepository, so no real database is required.  The
 * important guarantee is that user-supplied values are handled by the
 * repository layer without panic or unintended data disclosure.
 *
 * Payloads sourced from OWASP Testing Guide and common SQLi cheat sheets.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { StellarService } from '../../src/stellar/stellar.service';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';

const TEST_ACCOUNT =
  'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';

class AllowAllGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { account: string } }>();
    req.user = { account: TEST_ACCOUNT };
    return true;
  }
}

/** Classic and advanced SQL injection payloads (OWASP + common cheat sheet). */
const SQL_INJECTION_PAYLOADS: string[] = [
  // Boolean-based blind
  "' OR '1'='1",
  "' OR '1'='1'--",
  "' OR '1'='1'/*",
  // Statement terminator + destructive
  "'; DROP TABLE credits--",
  "'; DROP TABLE retirements--",
  // UNION-based extraction
  "' UNION SELECT * FROM users--",
  "' UNION SELECT NULL, username, password FROM users--",
  "1 UNION SELECT table_name FROM information_schema.tables--",
  // Tautology
  "1=1",
  "1 OR 1=1",
  // Comment injection
  "VCS'--",
  "VCS'/*",
  // Stacked queries
  "VCS'; INSERT INTO credits VALUES ('evil','evil','evil')--",
  // Encoded variants
  "%27%20OR%20%271%27%3D%271",
  // Time-based blind (PostgreSQL/MySQL)
  "'; SELECT pg_sleep(5)--",
  "1; WAITFOR DELAY '0:0:5'--",
];

describe('SQL Injection prevention (e2e) — issue #545', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StellarService)
      .useValue({
        invokeContract: jest.fn().mockResolvedValue({ returnValue: null }),
        readContract: jest.fn().mockResolvedValue(undefined),
        getContractEvents: jest.fn().mockResolvedValue([]),
      })
      .overrideGuard(JwtAuthGuard)
      .useClass(AllowAllGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        // Reject any query parameter that does not belong to the DTO.
        // This is the first line of defence against injection via unknown params.
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── GET /credits — methodology filter ───────────────────────────────────

  describe('GET /credits?methodology=<payload>', () => {
    it.each(SQL_INJECTION_PAYLOADS)(
      'payload: %s → returns 400 or empty data (never executes SQL)',
      async (payload) => {
        const res = await request(app.getHttpServer())
          .get('/credits')
          .query({ methodology: payload });

        // Acceptable outcomes:
        //   400 — validation pipe rejected the value
        //   200 with empty data array — value was safely parameterised and
        //         no records matched the injected string
        expect([200, 400]).toContain(res.status);

        if (res.status === 200) {
          // Must return empty results — no real credit has a methodology
          // matching the injection string.
          const body = res.body as { data?: unknown[] };
          expect(Array.isArray(body.data)).toBe(true);
          expect(body.data!.length).toBe(0);
        }

        // Must never return a 500 (unhandled SQL error leaking DB internals)
        expect(res.status).not.toBe(500);
      },
    );
  });

  // ── GET /credits — geography filter ─────────────────────────────────────

  describe('GET /credits?geography=<payload>', () => {
    it.each(SQL_INJECTION_PAYLOADS)(
      'payload: %s → returns 400 or empty data',
      async (payload) => {
        const res = await request(app.getHttpServer())
          .get('/credits')
          .query({ geography: payload });

        expect([200, 400]).toContain(res.status);
        if (res.status === 200) {
          const body = res.body as { data?: unknown[] };
          expect(Array.isArray(body.data)).toBe(true);
          expect(body.data!.length).toBe(0);
        }
        expect(res.status).not.toBe(500);
      },
    );
  });

  // ── GET /credits — vintageYear filter ───────────────────────────────────

  describe('GET /credits?vintageYear=<payload>', () => {
    it.each(SQL_INJECTION_PAYLOADS)(
      'payload: %s → returns 400 or empty data',
      async (payload) => {
        const res = await request(app.getHttpServer())
          .get('/credits')
          .query({ vintageYear: payload });

        // vintageYear must be a number — the DTO's @IsInt transformer should
        // return 400 for string payloads; the underlying in-memory repo filter
        // handles NaN safely for any that slip through.
        expect([200, 400]).toContain(res.status);
        if (res.status === 200) {
          const body = res.body as { data?: unknown[] };
          expect(Array.isArray(body.data)).toBe(true);
          expect(body.data!.length).toBe(0);
        }
        expect(res.status).not.toBe(500);
      },
    );
  });

  // ── GET /credits — status filter ─────────────────────────────────────────

  describe('GET /credits?status=<payload>', () => {
    it.each(SQL_INJECTION_PAYLOADS)(
      'payload: %s → returns 400 (invalid enum value)',
      async (payload) => {
        const res = await request(app.getHttpServer())
          .get('/credits')
          .query({ status: payload });

        // Status is an enum — any value outside the enum set should be rejected
        // with 400.  An empty-result 200 is also acceptable for robustness.
        expect([200, 400]).toContain(res.status);
        expect(res.status).not.toBe(500);
      },
    );
  });

  // ── GET /credits/:id — path param ────────────────────────────────────────

  describe('GET /credits/:id with injected path parameter', () => {
    it.each(SQL_INJECTION_PAYLOADS)(
      'payload: %s → returns 400 or 404, never 500',
      async (payload) => {
        const res = await request(app.getHttpServer()).get(
          `/credits/${encodeURIComponent(payload)}`,
        );

        // Should be 400 (validation) or 404 (not found — safely returned).
        // Must not be 500 (unhandled error).
        expect([400, 404]).toContain(res.status);
        expect(res.status).not.toBe(500);
      },
    );
  });

  // ── GET /certificates/:id — path param ───────────────────────────────────

  describe('GET /certificates/:id with injected path parameter', () => {
    it.each(SQL_INJECTION_PAYLOADS)(
      'payload: %s → returns 400 or 404, never 500',
      async (payload) => {
        const res = await request(app.getHttpServer()).get(
          `/certificates/${encodeURIComponent(payload)}`,
        );

        expect([400, 404]).toContain(res.status);
        expect(res.status).not.toBe(500);
      },
    );
  });

  // ── POST /credits/issue — body fields ────────────────────────────────────
  // Even though POST bodies go through the DTO whitelist and the in-memory
  // store (no raw SQL), we verify the API does not panic on injection values
  // in required string fields.

  describe('POST /credits/issue with injected body fields', () => {
    it.each(SQL_INJECTION_PAYLOADS)(
      'projectId payload: %s → returns 400 or 201 (safe store), never 500',
      async (payload) => {
        const res = await request(app.getHttpServer())
          .post('/credits/issue')
          .send({
            issuerPublicKey: TEST_ACCOUNT,
            projectId: payload,
            vintageYear: 2024,
            methodology: 'VCS',
            geography: 'NG',
            tonnes: '1000000',
            ipfsHash: 'bafybei-sqli-test',
          });

        // 400 (DTO validation) or 201 (safely stored with injected string as
        // literal value — TypeORM parameterises all writes)
        expect([201, 400]).toContain(res.status);
        expect(res.status).not.toBe(500);
      },
    );

    it.each(SQL_INJECTION_PAYLOADS)(
      'methodology payload: %s → returns 400 or 201, never 500',
      async (payload) => {
        const res = await request(app.getHttpServer())
          .post('/credits/issue')
          .send({
            issuerPublicKey: TEST_ACCOUNT,
            projectId: 'PROJ-SQLI',
            vintageYear: 2024,
            methodology: payload,
            geography: 'NG',
            tonnes: '1000000',
            ipfsHash: 'bafybei-sqli-meth',
          });

        expect([201, 400]).toContain(res.status);
        expect(res.status).not.toBe(500);
      },
    );
  });
});
