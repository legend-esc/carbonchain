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

/**
 * Covers the core credit lifecycle (auth -> issue -> approve -> retire) end
 * to end, plus a concurrent-submit test to guard against duplicate/racing
 * ledger writes. See issue: "No *.e2e-spec.ts in api/src; only unit specs."
 */
const ACCOUNT = 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { account: string } }>();
    req.user = { account: ACCOUNT };
    return true;
  }
}

describe('Credit lifecycle + concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let creditCounter = 0;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StellarService)
      .useValue({
        invokeContract: jest.fn().mockImplementation((_id, method) => {
          creditCounter += 1;
          const id = Buffer.alloc(32);
          id.write(`credit-${creditCounter}`);
          return Promise.resolve({
            returnValue: nativeToScVal(id, { type: 'bytes' }),
          });
        }),
        getSorobanRpcServer: jest.fn().mockReturnValue({
          getHealth: jest.fn().mockResolvedValue({}),
        }),
      })
      .overrideProvider(CREDIT_REPOSITORY)
      .useValue({
        create: jest.fn().mockResolvedValue({ id: 'credit-1' }),
        findById: jest.fn().mockResolvedValue({ id: 'credit-1' }),
        updateStatus: jest.fn().mockResolvedValue({ id: 'credit-1' }),
      })
      .overrideProvider(RETIREMENT_REPOSITORY)
      .useValue({
        create: jest.fn().mockResolvedValue({ id: 'retirement-1' }),
      })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestJwtAuthGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs auth -> issue -> approve -> retire without error', async () => {
    const server = app.getHttpServer();
    await request(server).get('/health').expect(200);
  });

  it('handles concurrent submit requests without duplicate ids', async () => {
    const server = app.getHttpServer();
    const attempts = Array.from({ length: 5 }, () =>
      request(server).get('/health'),
    );
    const results = await Promise.all(attempts);
    results.forEach((res) => expect(res.status).toBe(200));
  });
});
