import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { CreditStatus } from '../shared';

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

  beforeEach(() => {
    guard = new AdminGuard();
  });

  it('should allow admin users', () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { account: 'GADMIN', role: 'admin' } }),
      }),
    } as any;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should throw ForbiddenException for non-admin users', () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { account: 'GUSER', role: 'user' } }),
      }),
    } as any;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when no user', () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as any;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
