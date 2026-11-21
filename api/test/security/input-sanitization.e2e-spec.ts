/**
 * Issue #1382 — Adversarial security E2E test suite for credit project metadata
 * and retirement beneficiary/reason input sanitization.
 *
 * Injects SQL injection, XSS, null-byte truncation, control/ANSI sequences,
 * and oversized Unicode payloads into credit submission and retirement
 * endpoints, verifying:
 *
 *   1. Malicious payloads are rejected at the API boundary (400 / 404) BEFORE
 *      reaching `StellarService.invokeContract`.
 *   2. The application never returns 500 (no unhandled crashes or DB desync).
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

const TEST_ACCOUNT = 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';
const VALID_CREDIT_ID = 'a'.repeat(64);

class AllowAllGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { account: string } }>();
    req.user = { account: TEST_ACCOUNT };
    return true;
  }
}

interface AdversarialCase {
  label: string;
  payload: string;
}

const ADVERSARIAL_PAYLOADS: AdversarialCase[] = [
  // SQL injection
  { label: 'SQLi tautology', payload: "' OR '1'='1" },
  { label: 'SQLi stacked drop', payload: "PROJ-001'; DROP TABLE credits;--" },
  {
    label: 'SQLi UNION extract',
    payload: "' UNION SELECT NULL, username, password FROM users--",
  },
  // XSS
  { label: 'XSS script tag', payload: '<script>alert("xss")</script>' },
  { label: 'XSS img onerror', payload: '<img src=x onerror=alert(1)>' },
  { label: 'XSS javascript URI', payload: 'javascript:alert(document.cookie)' },
  // Null-byte truncation
  { label: 'Null-byte mid-string', payload: 'PROJ-001\x00admin' },
  { label: 'Null-byte URL-style', payload: 'bafybei\u0000evilhash' },
  // Control sequences & CRLF
  { label: 'ANSI escape sequence', payload: '\x1b[31mMALICIOUS\x1b[0m' },
  {
    label: 'CRLF header injection',
    payload: 'PROJ-001\r\nSet-Cookie: session=evil',
  },
  { label: 'C0 control chars', payload: 'offset\x07\x08\x1freason' },
  // Oversized Unicode & Bidi spoofing
  { label: 'Oversized ASCII (10k)', payload: 'A'.repeat(10_000) },
  {
    label: 'Oversized astral emoji (5k)',
    payload: '🔥'.repeat(5_000),
  },
  {
    label: 'Unicode Bidi override + zero-width',
    payload: 'PROJ\u202e\u200b\u200c\u200dEVIL',
  },
];

describe('Input sanitization & fuzz security (e2e) — issue #1382', () => {
  let app: INestApplication<App>;
  let invokeContractMock: jest.Mock;

  beforeAll(async () => {
    invokeContractMock = jest.fn().mockResolvedValue({ returnValue: null });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StellarService)
      .useValue({
        invokeContract: invokeContractMock,
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
      }),
    );
    await app.init();
  });

  beforeEach(() => {
    invokeContractMock.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  const baseIssueBody = (overrides: Record<string, unknown>) => ({
    issuerPublicKey: TEST_ACCOUNT,
    projectId: 'PROJ-001',
    vintageYear: 2024,
    methodology: 'VCS',
    geography: 'NG',
    tonnes: '1000000',
    ipfsHash: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    nonce: String(Date.now()),
    ...overrides,
  });

  describe('POST /credits/issue — projectId fuzzing', () => {
    it.each(ADVERSARIAL_PAYLOADS)(
      'rejects or safely handles $label without crashing',
      async ({ payload }) => {
        const res = await request(app.getHttpServer())
          .post('/credits/issue')
          .send(baseIssueBody({ projectId: payload }));

        expect(res.status).not.toBe(500);
        if (res.status === 400) {
          expect(invokeContractMock).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe('POST /credits/issue — ipfsHash fuzzing', () => {
    it.each(ADVERSARIAL_PAYLOADS)(
      'rejects or safely handles $label without crashing',
      async ({ payload }) => {
        const res = await request(app.getHttpServer())
          .post('/credits/issue')
          .send(baseIssueBody({ ipfsHash: payload }));

        expect(res.status).not.toBe(500);
        if (res.status === 400) {
          expect(invokeContractMock).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe('POST /credits/issue — methodology & geography strict validation', () => {
    it.each(ADVERSARIAL_PAYLOADS)(
      'rejects $label in methodology before contract call',
      async ({ payload }) => {
        const res = await request(app.getHttpServer())
          .post('/credits/issue')
          .send(baseIssueBody({ methodology: payload }));

        expect(res.status).toBe(400);
        expect(invokeContractMock).not.toHaveBeenCalled();
      },
    );

    it.each(ADVERSARIAL_PAYLOADS)(
      'rejects $label in geography before contract call',
      async ({ payload }) => {
        const res = await request(app.getHttpServer())
          .post('/credits/issue')
          .send(baseIssueBody({ geography: payload }));

        expect(res.status).toBe(400);
        expect(invokeContractMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('POST /retirement — creditId & reason fuzzing', () => {
    it.each(ADVERSARIAL_PAYLOADS)(
      'rejects $label in creditId before contract call',
      async ({ payload }) => {
        const res = await request(app.getHttpServer())
          .post('/retirement')
          .send({
            creditId: payload,
            reason: '2024 Scope 3 offset',
            nonce: 0,
          });

        expect(res.status).toBe(400);
        expect(invokeContractMock).not.toHaveBeenCalled();
      },
    );

    it.each(ADVERSARIAL_PAYLOADS)(
      'rejects or safely handles $label in retirement reason without 500',
      async ({ payload }) => {
        const res = await request(app.getHttpServer())
          .post('/retirement')
          .send({
            creditId: VALID_CREDIT_ID,
            reason: payload,
            nonce: 0,
          });

        // Either 400 (DTO MaxLength/validation rejection) or 404 (credit not found)
        expect([400, 404]).toContain(res.status);
        expect(res.status).not.toBe(500);
        expect(invokeContractMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('POST /credits/:id/retire — beneficiary/reason & non-whitelisted field rejection', () => {
    it('rejects unexpected beneficiary field via forbidNonWhitelisted', async () => {
      const res = await request(app.getHttpServer())
        .post(`/credits/${VALID_CREDIT_ID}/retire`)
        .send({
          reason: '2024 Scope 3 offset',
          beneficiary: '<script>alert(1)</script>',
        });

      expect(res.status).toBe(400);
      expect(invokeContractMock).not.toHaveBeenCalled();
    });

    it.each(ADVERSARIAL_PAYLOADS)(
      'handles $label in /credits/:id/retire reason without 500 or contract call',
      async ({ payload }) => {
        const res = await request(app.getHttpServer())
          .post(`/credits/${VALID_CREDIT_ID}/retire`)
          .send({ reason: payload, nonce: 0 });

        expect([400, 404]).toContain(res.status);
        expect(res.status).not.toBe(500);
        expect(invokeContractMock).not.toHaveBeenCalled();
      },
    );
  });
});
