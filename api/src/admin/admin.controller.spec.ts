import { ExecutionContext, ForbiddenException, NotImplementedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { nativeToScVal } from '@stellar/stellar-sdk';

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
              totalRetirements: 5,
              activeVerifiers: 3,
              paused: false,
              contractPauseStatus: 'unpaused',
              health: { degraded: false },
            }),
            registerVerifier: jest.fn().mockResolvedValue({ registered: true, address: 'GVER1' }),
            suspendVerifier: jest.fn().mockResolvedValue({ suspended: true }),
            // #924 — flagCredit and configureVerifier throw 501
            flagCredit: jest.fn().mockRejectedValue(new NotImplementedException()),
            configureVerifier: jest.fn().mockRejectedValue(new NotImplementedException()),
            registerMethodology: jest.fn().mockReturnValue({
              registered: true,
              name: 'VCS',
              description: 'Verified Carbon Standard',
            }),
            getNonce: jest
              .fn()
              .mockReturnValue({ address: 'GADMIN', nonce: 5 }),
            setRequiredApprovals: jest
              .fn()
              .mockReturnValue({ requiredApprovals: 2 }),
            pauseContract: jest.fn().mockResolvedValue({ paused: true }),
            unpauseContract: jest.fn().mockResolvedValue({ paused: false }),
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

  it('GET /admin/stats returns stats with tri-state contractPauseStatus', async () => {
    const result = await controller.getStats();
    expect(result.activeVerifiers).toBe(3);
    expect(result.contractPauseStatus).toBe('unpaused');
    expect(result.health.degraded).toBe(false);
    expect(service.getStats).toHaveBeenCalled();
  });

  it('POST /admin/verifiers/register calls registerVerifier on-chain', async () => {
    const result = await controller.registerVerifier({ address: 'GVER1' });
    expect(result).toEqual({ registered: true, address: 'GVER1' });
    expect(service.registerVerifier).toHaveBeenCalledWith('GVER1');
  });

  it('POST /admin/verifiers/:id/suspend calls suspendVerifier (on-chain remove)', async () => {
    const result = await controller.suspendVerifier('GVER1');
    expect(result).toEqual({ suspended: true });
    expect(service.suspendVerifier).toHaveBeenCalledWith('GVER1');
  });

  it('#924 — POST /admin/credits/:id/flag returns 501 NotImplementedException', async () => {
    await expect(controller.flagCredit('abc')).rejects.toThrow(NotImplementedException);
    expect(service.flagCredit).toHaveBeenCalledWith('abc');
  });

  it('#924 — POST /admin/verifiers/:id/configure returns 501 NotImplementedException', async () => {
    await expect(
      controller.configureVerifier('GVER1', { methodologies: ['VCS'] }),
    ).rejects.toThrow(NotImplementedException);
    expect(service.configureVerifier).toHaveBeenCalledWith('GVER1', { methodologies: ['VCS'] });
  });

  it('POST /admin/methodologies calls registerMethodology', () => {
    const result = controller.registerMethodology({
      name: 'VCS',
      description: 'Verified Carbon Standard',
    });
    expect(result).toEqual({
      registered: true,
      name: 'VCS',
      description: 'Verified Carbon Standard',
    });
    expect(service.registerMethodology).toHaveBeenCalledWith(
      'VCS',
      'Verified Carbon Standard',
    );
  });

  it('GET /admin/nonce/:address calls getNonce', () => {
    const result = controller.getNonce('GADMIN');
    expect(result).toEqual({ address: 'GADMIN', nonce: 5 });
    expect(service.getNonce).toHaveBeenCalledWith('GADMIN');
  });

  it('POST /admin/required-approvals calls setRequiredApprovals', () => {
    const result = controller.setRequiredApprovals({ threshold: 2 });
    expect(result).toEqual({ requiredApprovals: 2 });
    expect(service.setRequiredApprovals).toHaveBeenCalledWith(2);
  });

  it('POST /admin/pause calls pauseContract', async () => {
    jest.spyOn(service, 'pauseContract').mockResolvedValue({ paused: true });
    const result = await controller.pause();
    expect(result).toEqual({ paused: true });
    expect(service.pauseContract).toHaveBeenCalled();
  });

  it('POST /admin/unpause calls unpauseContract', async () => {
    jest.spyOn(service, 'unpauseContract').mockResolvedValue({ paused: false });
    const result = await controller.unpause();
    expect(result).toEqual({ paused: false });
    expect(service.unpauseContract).toHaveBeenCalled();
  });
});

describe('AdminGuard', () => {
  let guard: AdminGuard;
  const ADMIN = 'GBCI2DH7MEKQUTCXZ7YLEVOZHDMBWPCMB6V46ZQHOUN2BHBWRWYY2JRP';

  const mockConfigService = {
    get: jest.fn((key: string) =>
      key === 'CREDIT_REGISTRY_CONTRACT_ID'
        ? 'CAABCAABCAABCAABCAABCAABCAABCAABCAAB'
        : undefined,
    ),
  };
  const mockCache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };
  const mockStellar = {
    readContract: jest
      .fn()
      .mockResolvedValue(nativeToScVal(ADMIN, { type: 'address' })),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AdminGuard(
      mockConfigService as any,
      mockStellar as any,
      mockCache as any,
    );
  });

  it('should allow admin users', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { account: ADMIN, role: 'admin' } }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockStellar.readContract).toHaveBeenCalledWith(
      'CAABCAABCAABCAABCAABCAABCAABCAABCAAB',
      'get_admin',
      [],
    );
  });

  it('should throw ForbiddenException for non-admin users', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { account: 'GUSER', role: 'user' } }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when no user', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });
});
