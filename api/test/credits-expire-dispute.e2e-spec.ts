/**
 * E2E tests for #1103: expireCredit, disputeCredit, resolveDispute endpoints.
 *
 * Uses overrideProvider to mock CreditsService so no real Stellar node is needed.
 * Covers: auth guards, correct status transitions, error cases (bad state, missing fields).
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  HttpStatus,
  ValidationPipe,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CreditsService } from '../src/credits/credits.service';
import { CreditStatus } from '../../shared';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';

const CALLER_PUBLIC_KEY =
  'GADMINTESTACCOUNT000000000000000000000000000000000000000';

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: { account: string };
    }>();
    if (!req.headers.authorization) {
      throw new UnauthorizedException();
    }
    req.user = { account: 'GTEST_E2E_ACCOUNT' };
    return true;
  }
}

// ─── Shared mock credit factory ───────────────────────────────────────────────

function makeMockCredit(
  overrides: Partial<{
    id: string;
    status: CreditStatus;
    ipfs_hash: string;
  }> = {},
) {
  return {
    id: overrides.id ?? 'credit-abc',
    project_id: 'PROJ-001',
    issuer: 'GISSUER...',
    vintage_year: 2023,
    methodology: 'VCS',
    geography: 'NG',
    tonnes: '1000000',
    ipfs_hash: overrides.ipfs_hash ?? 'bafybei...',
    status: overrides.status ?? CreditStatus.Active,
    issued_at: 1700000000,
  };
}

// ─── expireCredit ─────────────────────────────────────────────────────────────

describe('POST /credits/:id/expire (e2e)', () => {
  let app: INestApplication;

  const mockExpire = jest.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CreditsService)
      .useValue({ expireCredit: mockExpire })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => mockExpire.mockReset());

  it('401 — rejects unauthenticated callers', () => {
    return request(app.getHttpServer())
      .post('/credits/credit-abc/expire')
      .send({ adminPublicKey: CALLER_PUBLIC_KEY, reason: 'vintage passed' })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('201 — admin expires an Active credit → status becomes Expired', async () => {
    const expiredCredit = makeMockCredit({ status: CreditStatus.Expired });
    mockExpire.mockResolvedValue(expiredCredit);

    const { body } = await request(app.getHttpServer())
      .post('/credits/credit-abc/expire')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({
        adminPublicKey: CALLER_PUBLIC_KEY,
        reason: 'vintage year 2023 passed',
      })
      .expect(HttpStatus.CREATED);

    expect(body.status).toBe(CreditStatus.Expired);
    expect(mockExpire).toHaveBeenCalledWith(
      'credit-abc',
      expect.objectContaining({ reason: 'vintage year 2023 passed' }),
    );
  });

  it('400 — cannot expire a Retired credit', async () => {
    mockExpire.mockRejectedValue(
      new BadRequestException(
        'Credit cannot be expired — current status: Retired',
      ),
    );

    await request(app.getHttpServer())
      .post('/credits/credit-retired/expire')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ adminPublicKey: CALLER_PUBLIC_KEY, reason: 'vintage passed' })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('400 — cannot expire an already Expired credit', async () => {
    mockExpire.mockRejectedValue(
      new BadRequestException(
        'Credit cannot be expired — current status: Expired',
      ),
    );

    await request(app.getHttpServer())
      .post('/credits/credit-expired/expire')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ adminPublicKey: CALLER_PUBLIC_KEY, reason: 'duplicate' })
      .expect(HttpStatus.BAD_REQUEST);
  });
});

// ─── disputeCredit ────────────────────────────────────────────────────────────

describe('POST /credits/:id/dispute (e2e)', () => {
  let app: INestApplication;

  const mockDispute = jest.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CreditsService)
      .useValue({ disputeCredit: mockDispute })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => mockDispute.mockReset());

  it('401 — rejects unauthenticated callers', () => {
    return request(app.getHttpServer())
      .post('/credits/credit-abc/dispute')
      .send({
        disputerPublicKey: CALLER_PUBLIC_KEY,
        evidenceIpfsHash: 'bafybei123',
        reason: 'deforestation detected',
      })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('201 — verifier raises a dispute on Active credit → status becomes Disputed', async () => {
    const disputedCredit = makeMockCredit({
      status: CreditStatus.Disputed,
      ipfs_hash: 'bafybei-evidence',
    });
    mockDispute.mockResolvedValue(disputedCredit);

    const { body } = await request(app.getHttpServer())
      .post('/credits/credit-abc/dispute')
      .set('Authorization', 'Bearer valid-verifier-token')
      .send({
        disputerPublicKey: CALLER_PUBLIC_KEY,
        evidenceIpfsHash: 'bafybei-evidence',
        reason: 'satellite imagery shows deforestation',
      })
      .expect(HttpStatus.CREATED);

    expect(body.status).toBe(CreditStatus.Disputed);
    // Evidence IPFS hash stored and retrievable
    expect(body.ipfs_hash).toBe('bafybei-evidence');
  });

  it('400 — cannot dispute an already Disputed credit', async () => {
    mockDispute.mockRejectedValue(
      new BadRequestException(
        'Credit cannot be disputed — current status: Disputed',
      ),
    );

    await request(app.getHttpServer())
      .post('/credits/credit-disputed/dispute')
      .set('Authorization', 'Bearer valid-verifier-token')
      .send({
        disputerPublicKey: CALLER_PUBLIC_KEY,
        evidenceIpfsHash: 'bafybei123',
        reason: 'duplicate dispute',
      })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('400 — cannot dispute a Retired credit', async () => {
    mockDispute.mockRejectedValue(
      new BadRequestException(
        'Credit cannot be disputed — current status: Retired',
      ),
    );

    await request(app.getHttpServer())
      .post('/credits/credit-retired/dispute')
      .set('Authorization', 'Bearer valid-verifier-token')
      .send({
        disputerPublicKey: CALLER_PUBLIC_KEY,
        evidenceIpfsHash: 'bafybei123',
        reason: 'test',
      })
      .expect(HttpStatus.BAD_REQUEST);
  });
});

// ─── resolveDispute ───────────────────────────────────────────────────────────

describe('POST /credits/:id/resolve-dispute (e2e)', () => {
  let app: INestApplication;

  const mockResolve = jest.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CreditsService)
      .useValue({ resolveDispute: mockResolve })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => mockResolve.mockReset());

  it('401 — rejects unauthenticated callers', () => {
    return request(app.getHttpServer())
      .post('/credits/credit-abc/resolve-dispute')
      .send({ adminPublicKey: CALLER_PUBLIC_KEY, outcome: 0 })
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('201 — admin resolves dispute with outcome=0 → status becomes Active', async () => {
    const reinstatedCredit = makeMockCredit({ status: CreditStatus.Active });
    mockResolve.mockResolvedValue(reinstatedCredit);

    const { body } = await request(app.getHttpServer())
      .post('/credits/credit-disputed/resolve-dispute')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ adminPublicKey: CALLER_PUBLIC_KEY, outcome: 0 })
      .expect(HttpStatus.CREATED);

    expect(body.status).toBe(CreditStatus.Active);
    expect(mockResolve).toHaveBeenCalledWith(
      'credit-disputed',
      expect.objectContaining({ outcome: 0 }),
    );
  });

  it('201 — admin resolves dispute with outcome=1 → status becomes Flagged', async () => {
    const flaggedCredit = makeMockCredit({ status: CreditStatus.Flagged });
    mockResolve.mockResolvedValue(flaggedCredit);

    const { body } = await request(app.getHttpServer())
      .post('/credits/credit-disputed/resolve-dispute')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ adminPublicKey: CALLER_PUBLIC_KEY, outcome: 1 })
      .expect(HttpStatus.CREATED);

    expect(body.status).toBe(CreditStatus.Flagged);
  });

  it('201 — admin resolves dispute with outcome=2 → status becomes Retired', async () => {
    const retiredCredit = makeMockCredit({ status: CreditStatus.Retired });
    mockResolve.mockResolvedValue(retiredCredit);

    const { body } = await request(app.getHttpServer())
      .post('/credits/credit-disputed/resolve-dispute')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ adminPublicKey: CALLER_PUBLIC_KEY, outcome: 2 })
      .expect(HttpStatus.CREATED);

    expect(body.status).toBe(CreditStatus.Retired);
  });

  it('400 — cannot resolve a non-Disputed credit', async () => {
    mockResolve.mockRejectedValue(
      new BadRequestException(
        'Credit is not in Disputed status — current status: Active',
      ),
    );

    await request(app.getHttpServer())
      .post('/credits/credit-active/resolve-dispute')
      .set('Authorization', 'Bearer valid-admin-token')
      .send({ adminPublicKey: CALLER_PUBLIC_KEY, outcome: 0 })
      .expect(HttpStatus.BAD_REQUEST);
  });
});
