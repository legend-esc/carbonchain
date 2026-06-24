import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { CreditStatus } from '../shared';
import { StellarService } from '../stellar/stellar.service';
import { CacheService } from '../common/cache.service';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';

jest.mock('@stellar/stellar-sdk', () => ({
  ...jest.requireActual('@stellar/stellar-sdk'),
  scValToNative: jest.fn((val: any) => val),
}));

describe('AdminController', () => {
  let controller: AdminController;
  let service: jest.Mocked<AdminService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        {
          provide: AdminService,
          useValue: {
            getStats: jest.fn().mockResolvedValue({
              totalCredits: 0,
              totalRetirements: 0,
              activeVerifiers: 3,
            }),
            suspendVerifier: jest.fn().mockResolvedValue({ suspended: true }),
            flagCredit: jest.fn().mockResolvedValue({
              flagged: true,
              creditId: 'abc',
              status: CreditStatus.Flagged,
            }),
          },
        },
      ],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AdminController);
    service = module.get(AdminService);
  });

  it('GET /admin/stats returns stats', async () => {
    const result = await controller.getStats();
    expect(result.activeVerifiers).toBe(3);
    expect(service.getStats).toHaveBeenCalled();
  });

  it('POST /admin/verifiers/:id/suspend calls suspendVerifier', async () => {
    const result = await controller.suspendVerifier('GVER1');
    expect(result).toEqual({ suspended: true });
    expect(service.suspendVerifier).toHaveBeenCalledWith('GVER1');
  });

  it('POST /admin/credits/:id/flag calls flagCredit', async () => {
    const result = await controller.flagCredit('abc');
    expect(result).toEqual({
      flagged: true,
      creditId: 'abc',
      status: CreditStatus.Flagged,
    });
    expect(service.flagCredit).toHaveBeenCalledWith('abc');
  });
});

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let mockStellarService: any;
  let mockConfigService: any;
  let mockCacheService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStellarService = {
      readContract: jest.fn().mockResolvedValue('GADMIN'),
    };
    mockCacheService = {};
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'CREDIT_REGISTRY_CONTRACT_ID') return 'CCONTRACT';
        return '';
      }),
    };
    guard = new AdminGuard(
      mockStellarService,
      mockConfigService,
      mockCacheService,
    );
  });

  it('should allow admin users', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { account: 'GADMIN' } }),
      }),
    } as any;
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should throw ForbiddenException for non-admin users', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { account: 'GUSER' } }),
      }),
    } as any;
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when no user', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as any;
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });
});
