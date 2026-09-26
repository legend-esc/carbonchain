import { Test, TestingModule } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { CreditStatus } from '../../../shared';

const mockReq = {
  user: { account: 'GADMINPUBLICKEY' },
  headers: { 'x-request-id': 'req-1', 'user-agent': 'jest' },
  ip: '127.0.0.1',
};

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
              paused: false,
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
            getNonce: jest
              .fn()
              .mockResolvedValue({ address: 'GADMIN', nonce: 5 }),
            setRequiredApprovals: jest
              .fn()
              .mockResolvedValue({ requiredApprovals: 2 }),
            pauseContract: jest.fn().mockResolvedValue({ paused: true }),
            unpauseContract: jest.fn().mockResolvedValue({ paused: false }),
            setMinStake: jest.fn().mockResolvedValue({ minStake: '5000000' }),
            slashVerifier: jest.fn().mockResolvedValue({
              slashed: true,
              verifier: 'GVER1',
              creditId: 'cid1',
            }),
            registerVerifier: jest
              .fn()
              .mockResolvedValue({ registered: true, address: 'GVER1' }),
            configureVerifier: jest
              .fn()
              .mockResolvedValue({ configured: true, verifierId: 'GVER1' }),
            getAuditLog: jest
              .fn()
              .mockResolvedValue({ rows: [], total: 0 }),
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

  it('GET /admin/audit calls getAuditLog with parsed options', async () => {
    const result = await controller.getAuditLog(
      'GADMIN',
      'pause_contract',
      '2024-01-01',
      '2024-12-31',
      '10',
      '0',
    );
    expect(result).toEqual({ rows: [], total: 0 });
    expect(service.getAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'GADMIN',
        action: 'pause_contract',
        limit: 10,
        offset: 0,
      }),
    );
  });

  it('GET /admin/audit with no filters calls getAuditLog with empty opts', async () => {
    await controller.getAuditLog();
    expect(service.getAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actor: undefined, action: undefined }),
    );
  });

  it('POST /admin/verifiers/:id/suspend calls suspendVerifier with audit ctx', async () => {
    const result = await controller.suspendVerifier('GVER1', mockReq);
    expect(result).toEqual({ suspended: true });
    expect(service.suspendVerifier).toHaveBeenCalledWith(
      'GVER1',
      expect.objectContaining({ actor: 'GADMINPUBLICKEY' }),
    );
  });

  it('POST /admin/credits/:id/flag calls flagCredit with audit ctx', async () => {
    const result = await controller.flagCredit('abc', mockReq);
    expect(result).toEqual({
      flagged: true,
      creditId: 'abc',
      status: CreditStatus.Flagged,
    });
    expect(service.flagCredit).toHaveBeenCalledWith(
      'abc',
      expect.objectContaining({ actor: 'GADMINPUBLICKEY' }),
    );
  });

  it('POST /admin/methodologies calls registerMethodology with audit ctx', () => {
    const result = controller.registerMethodology(
      { name: 'VCS', description: 'Verified Carbon Standard' },
      mockReq,
    );
    expect(result).toEqual({
      registered: true,
      name: 'VCS',
      description: 'Verified Carbon Standard',
    });
    expect(service.registerMethodology).toHaveBeenCalledWith(
      'VCS',
      'Verified Carbon Standard',
      expect.objectContaining({ actor: 'GADMINPUBLICKEY' }),
    );
  });

  it('GET /admin/nonce/:address calls getNonce', async () => {
    const result = await controller.getNonce('GADMIN');
    expect(result).toEqual({ address: 'GADMIN', nonce: 5 });
    expect(service.getNonce).toHaveBeenCalledWith('GADMIN');
  });

  it('POST /admin/required-approvals calls setRequiredApprovals with audit ctx', async () => {
    const result = await controller.setRequiredApprovals({ threshold: 2 }, mockReq);
    expect(result).toEqual({ requiredApprovals: 2 });
    expect(service.setRequiredApprovals).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ actor: 'GADMINPUBLICKEY' }),
    );
  });

  it('POST /admin/pause calls pauseContract with audit ctx', async () => {
    const result = await controller.pause(mockReq);
    expect(result).toEqual({ paused: true });
    expect(service.pauseContract).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'GADMINPUBLICKEY' }),
    );
  });

  it('POST /admin/unpause calls unpauseContract with audit ctx', async () => {
    const result = await controller.unpause(mockReq);
    expect(result).toEqual({ paused: false });
    expect(service.unpauseContract).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'GADMINPUBLICKEY' }),
    );
  });
});
