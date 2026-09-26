import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { AdminService } from './admin.service';
import { AdminAuditEntity } from './admin-audit.entity';
import { CreditsService } from '../credits/credits.service';
import { VerifiersService } from '../verifiers/verifiers.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { RetirementService } from '../retirement/retirement.service';
import { CreditStatus } from '../../../shared';
import { Keypair } from '@stellar/stellar-sdk';

const mockCredit = {
  id: 'abc123',
  project_id: 'proj_1',
  issuer: 'GABC',
  vintage_year: 2024,
  methodology: 'VCS',
  geography: 'NG',
  tonnes: '1000000',
  ipfs_hash: 'bafybei',
  status: CreditStatus.Active,
  issued_at: 1700000000,
};

const mockAuditCtx = {
  actor: 'GADMINPUBLICKEY',
  ipAddress: '127.0.0.1',
  userAgent: 'jest-test',
  requestId: 'req-123',
};

describe('AdminService', () => {
  let service: AdminService;
  let creditsService: jest.Mocked<CreditsService>;
  let verifiersService: jest.Mocked<VerifiersService>;
  let stellarService: jest.Mocked<StellarService>;
  let keypairService: jest.Mocked<StellarKeypairService>;
  let auditRepo: {
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  const mockAdminKeypair = Keypair.random();

  beforeEach(async () => {
    const mockQb = {
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    auditRepo = {
      create: jest.fn().mockImplementation((v) => v),
      save: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn().mockReturnValue(mockQb),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: CreditsService,
          useValue: {
            getCredit: jest.fn().mockResolvedValue(mockCredit),
            getCreditCount: jest.fn().mockResolvedValue(42),
          },
        },
        {
          provide: VerifiersService,
          useValue: {
            listVerifiers: jest
              .fn()
              .mockResolvedValue([{ address: 'GVER1' }, { address: 'GVER2' }]),
            getVerifier: jest.fn().mockResolvedValue({ address: 'GVER1' }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'CREDIT_REGISTRY_CONTRACT_ID')
                return 'CCGJQV2J3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3';
              return undefined;
            }),
          },
        },
        {
          provide: StellarService,
          useValue: {
            readContract: jest.fn(),
            invokeContract: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: StellarKeypairService,
          useValue: {
            getAdminKeypair: jest.fn().mockReturnValue(mockAdminKeypair),
            getAdminPublicKey: jest
              .fn()
              .mockReturnValue(mockAdminKeypair.publicKey()),
          },
        },
        {
          provide: getRepositoryToken(AdminAuditEntity),
          useValue: auditRepo,
          provide: RetirementService,
          useValue: {
            getTotalRetired: jest.fn().mockResolvedValue(0),
            listRetirements: jest.fn().mockResolvedValue({ total: 5 }),
          },
        },
      ],
    }).compile();

    service = module.get(AdminService);
    creditsService = module.get(CreditsService);
    verifiersService = module.get(VerifiersService);
    stellarService = module.get(StellarService);
    keypairService = module.get(StellarKeypairService);
  });

  describe('getStats', () => {
    it('should return stats with active verifier count and paused state', async () => {
      stellarService.readContract.mockResolvedValue({
        type: 'bool',
        value: false,
      } as any);
      const stats = await service.getStats();
      expect(stats.activeVerifiers).toBe(2);
      expect(stats).toHaveProperty('totalCredits');
      expect(stats).toHaveProperty('totalRetirements');
      expect(stats).toHaveProperty('paused');
      expect(stats.paused).toBe(false);
    });

    it('should default paused to false when contract call fails', async () => {
      stellarService.readContract.mockRejectedValue(
        new Error('Contract unavailable'),
      );
      const stats = await service.getStats();
      expect(stats.paused).toBe(false);
    });
  });

  describe('suspendVerifier', () => {
    it('should return suspended: true for existing verifier', async () => {
      const result = await service.suspendVerifier('GVER1', mockAuditCtx);
      expect(result).toEqual({ suspended: true });
      expect(verifiersService.getVerifier).toHaveBeenCalledWith('GVER1');
    });

    it('should write an audit row on success', async () => {
      await service.suspendVerifier('GVER1', mockAuditCtx);
      expect(auditRepo.save).toHaveBeenCalledTimes(1);
      expect(auditRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: mockAuditCtx.actor,
          action: 'suspend_verifier',
          target: 'GVER1',
        }),
      );
    });

    it('should propagate NotFoundException for unknown verifier', async () => {
      verifiersService.getVerifier.mockRejectedValue(new NotFoundException());
      await expect(service.suspendVerifier('UNKNOWN', mockAuditCtx)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('flagCredit', () => {
    it('should return flagged: true for existing credit', async () => {
      const result = await service.flagCredit('abc123', mockAuditCtx);
      expect(result).toEqual({
        flagged: true,
        creditId: 'abc123',
        status: CreditStatus.Flagged,
      });
      expect(creditsService.getCredit).toHaveBeenCalledWith('abc123');
    });

    it('should write an audit row capturing before/after state', async () => {
      await service.flagCredit('abc123', mockAuditCtx);
      expect(auditRepo.save).toHaveBeenCalledTimes(1);
      const createArg = auditRepo.create.mock.calls[0][0];
      expect(createArg.action).toBe('flag_credit');
      expect(createArg.target).toBe('abc123');
      expect(createArg.afterState).toMatchObject({
        flagged: true,
        creditId: 'abc123',
        status: CreditStatus.Flagged,
      });
    });

    it('should propagate NotFoundException for unknown credit', async () => {
      creditsService.getCredit.mockRejectedValue(new NotFoundException());
      await expect(service.flagCredit('UNKNOWN', mockAuditCtx)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('pauseContract', () => {
    it('should invoke pause on the credit registry and return paused: true', async () => {
      const result = await service.pauseContract(mockAuditCtx);
      expect(result).toEqual({ paused: true });
      expect(stellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'pause',
        expect.any(Array),
        mockAdminKeypair,
      );
    });

    it('should write audit row with action pause_contract', async () => {
      await service.pauseContract(mockAuditCtx);
      expect(auditRepo.save).toHaveBeenCalledTimes(1);
      const createArg = auditRepo.create.mock.calls[0][0];
      expect(createArg.action).toBe('pause_contract');
      expect(createArg.actor).toBe(mockAuditCtx.actor);
    });
  });

  describe('unpauseContract', () => {
    it('should invoke unpause on the credit registry and return paused: false', async () => {
      const result = await service.unpauseContract(mockAuditCtx);
      expect(result).toEqual({ paused: false });
      expect(stellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'unpause',
        expect.any(Array),
        mockAdminKeypair,
      );
    });

    it('should write audit row with action unpause_contract', async () => {
      await service.unpauseContract(mockAuditCtx);
      const createArg = auditRepo.create.mock.calls[0][0];
      expect(createArg.action).toBe('unpause_contract');
    });
  });

  describe('registerMethodology', () => {
    it('should return registered: true with the provided name and description', () => {
      const result = service.registerMethodology(
        'Gold Standard',
        'Gold Standard for the Global Goals',
        mockAuditCtx,
      );
      expect(result).toEqual({
        registered: true,
        name: 'Gold Standard',
        description: 'Gold Standard for the Global Goals',
      });
    });

    it('should return the exact name and description passed in', () => {
      const result = service.registerMethodology(
        'CDM',
        'Clean Development Mechanism',
        mockAuditCtx,
      );
      expect(result.name).toBe('CDM');
      expect(result.description).toBe('Clean Development Mechanism');
    });
  });

  describe('getNonce', () => {
    it('should return a nonce object with the requested address from on-chain', async () => {
      stellarService.readContract.mockResolvedValue(
        nativeToScVal(5n, { type: 'u64' }),
      );
      const result = await service.getNonce('GADMINPUBLICKEY');
      expect(result.address).toBe('GADMINPUBLICKEY');
      expect(typeof result.nonce).toBe('number');
    });

    it('should fall back to nonce 0 when contract call fails', async () => {
      stellarService.readContract.mockRejectedValue(
        new Error('Contract unavailable'),
      );
      const result = await service.getNonce('GADMINPUBLICKEY');
      expect(result.address).toBe('GADMINPUBLICKEY');
      expect(result.nonce).toBe(0);
    });
  });

  describe('setRequiredApprovals', () => {
    it('should call set_required_approvals on-chain and return the threshold', async () => {
      stellarService.readContract.mockResolvedValue(
        nativeToScVal(0n, { type: 'u64' }),
      );
      const result = await service.setRequiredApprovals(2, mockAuditCtx);
      expect(result).toEqual({ requiredApprovals: 2 });
      expect(stellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'set_required_approvals',
        expect.any(Array),
        mockAdminKeypair,
      );
    });

    it('should write an audit row for set_required_approvals', async () => {
      stellarService.readContract.mockResolvedValue(
        nativeToScVal(0n, { type: 'u64' }),
      );
      await service.setRequiredApprovals(3, mockAuditCtx);
      const createArg = auditRepo.create.mock.calls[0][0];
      expect(createArg.action).toBe('set_required_approvals');
      expect(createArg.afterState).toMatchObject({ requiredApprovals: 3 });
    });

    it('should return requiredApprovals: 1 when threshold is 1', async () => {
      stellarService.readContract.mockResolvedValue(
        nativeToScVal(0n, { type: 'u64' }),
      );
      const result = await service.setRequiredApprovals(1, mockAuditCtx);
      expect(result.requiredApprovals).toBe(1);
    });
  });

  describe('getAuditLog', () => {
    it('should return rows and total from repository query', async () => {
      const fakeRow = { id: 'uuid-1', action: 'pause_contract', actor: 'GADMIN' };
      const mockQb = {
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[fakeRow], 1]),
      };
      auditRepo.createQueryBuilder.mockReturnValue(mockQb);

      const result = await service.getAuditLog({ actor: 'GADMIN' });
      expect(result.total).toBe(1);
      expect(result.rows[0]).toEqual(fakeRow);
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        'a.actor = :actor',
        { actor: 'GADMIN' },
      );
    });

    it('should cap limit at 200', async () => {
      const mockQb = {
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      auditRepo.createQueryBuilder.mockReturnValue(mockQb);

      await service.getAuditLog({ limit: 999 });
      expect(mockQb.take).toHaveBeenCalledWith(200);
    });
  });
});
