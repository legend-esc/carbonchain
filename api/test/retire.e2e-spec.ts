import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { AppModule } from './../src/app.module';
import { StellarService } from './../src/stellar/stellar.service';
import type { ICreditRepository } from './../src/credits/credit.repository';
import { CREDIT_REPOSITORY } from './../src/credits/credit.repository';
import type { IRetirementRepository } from './../src/retirement/retirement.repository';
import { RETIREMENT_REPOSITORY } from './../src/retirement/retirement.repository';
import { JwtAuthGuard } from './../src/auth/jwt-auth.guard';
import { CreditStatus } from '../../shared';

const BUYER = 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { account: string } }>();
    req.user = { account: BUYER };
    return true;
  }
}

describe('Credit retirement lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let creditRepo: ICreditRepository;
  let retirementRepo: IRetirementRepository;
  let creditCounter = 0;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StellarService)
      .useValue({
        invokeContract: jest.fn().mockImplementation((_id, method) => {
          if (method === 'submit_credit') {
            creditCounter += 1;
            const id = Buffer.alloc(32);
            id.write(`credit-${creditCounter}`);
            return Promise.resolve({
              returnValue: nativeToScVal(id, { type: 'bytes' }),
            });
          }
          if (method === 'retire') {
            const retId = Buffer.alloc(32);
            retId.write('retirement-cert-001');
            return Promise.resolve({
              returnValue: nativeToScVal(retId, { type: 'bytes' }),
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
    retirementRepo = moduleFixture.get(RETIREMENT_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  it('issue → approve → retire full lifecycle', async () => {
    const { body: issued } = await request(app.getHttpServer())
      .post('/credits/issue')
      .send({
        issuerPublicKey: BUYER,
        projectId: 'PROJ-E2E',
        vintageYear: 2024,
        methodology: 'VCS',
        geography: 'NG',
        tonnes: '1000000',
        ipfsHash: 'bafybei-e2e-test',
      })
      .expect(201);

    const creditId = issued.creditId as string;
    expect(creditId).toBeDefined();

    const pending = await creditRepo.findById(creditId);
    expect(pending?.status).toBe(CreditStatus.Pending);

    const activeCredit = await creditRepo.findById(creditId);
    expect(activeCredit).toBeDefined();
    activeCredit!.status = CreditStatus.Active;
    await creditRepo.save(activeCredit!);

    const { body: retired } = await request(app.getHttpServer())
      .post(`/credits/${creditId}/retire`)
      .send({ reason: '2024 Scope 3 offset' })
      .expect(201);

    expect(retired.retirementId).toBeDefined();

    const certificate = await retirementRepo.findById(retired.retirementId);
    expect(certificate).toBeDefined();

    const retiredCredit = await creditRepo.findById(creditId);
    expect(retiredCredit?.status).toBe(CreditStatus.Retired);
  });

  it('returns 404 when credit is not in the off-chain index', async () => {
    await request(app.getHttpServer())
      .post('/credits/unknown-credit-id/retire')
      .send({ reason: 'offset' })
      .expect(404);
  });

  it('returns 409 when credit is not Active', async () => {
    const { body: issued } = await request(app.getHttpServer())
      .post('/credits/issue')
      .send({
        issuerPublicKey: BUYER,
        projectId: 'PROJ-PENDING',
        vintageYear: 2024,
        methodology: 'VCS',
        geography: 'NG',
        tonnes: '1000000',
        ipfsHash: 'bafybei-pending',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/credits/${issued.creditId}/retire`)
      .send({ reason: 'offset' })
      .expect(409);
  });
});
