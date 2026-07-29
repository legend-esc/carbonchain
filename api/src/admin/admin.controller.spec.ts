import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { CreditStatus } from '../../../shared';

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
            registerMethodology: jest.fn().mockReturnValue({
              registered: true,
              name: 'VCS',
              description: 'Verified Carbon Standard',
            }),
            getNonce: jest.fn().mockReturnValue({ address: 'GADMIN', nonce: 5 }),
            setRequiredApprovals: jest.fn().mockReturnValue({ requiredApprovals: 2 }),
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

  beforeEach(() => {
    guard = new AdminGuard();
  });

  it('should allow admin users', () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { account: 'GADMIN', role: 'admin' } }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should throw ForbiddenException for non-admin users', () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { account: 'GUSER', role: 'user' } }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when no user', () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
