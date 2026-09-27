import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { AdminService } from './admin.service';
import { VerifiersService } from '../verifiers/verifiers.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { Keypair } from '@stellar/stellar-sdk';
import { RETIREMENT_REPOSITORY } from '../retirement/retirement.repository';

describe('AdminService', () => {
  let service: AdminService;
  let verifiersService: jest.Mocked<VerifiersService>;
  let stellarService: jest.Mocked<StellarService>;
  let keypairService: jest.Mocked<StellarKeypairService>;

  const mockAdminKeypair = Keypair.random();

  const mockRetirementRepo = {
    save: jest.fn(),
    saveAll: jest.fn(),
    findById: jest.fn(),
    findByBuyer: jest.fn(),
    findAll: jest.fn(),
    // #925 — COUNT-based query
    count: jest.fn().mockResolvedValue(5),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
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
          provide: RETIREMENT_REPOSITORY,
          useValue: mockRetirementRepo,
        },
      ],
    }).compile();

    service = module.get(AdminService);
    verifiersService = module.get(VerifiersService);
    stellarService = module.get(StellarService);
    keypairService = module.get(StellarKeypairService);
    jest.clearAllMocks();
    // reset count mock after clearAllMocks
    mockRetirementRepo.count.mockResolvedValue(5);
  });

  // ── #925 + #926 ────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('should return stats with activeVerifierCount and tri-state contractPauseStatus', async () => {
      verifiersService.listVerifiers = jest
        .fn()
        .mockResolvedValue([{ address: 'GVER1' }, { address: 'GVER2' }]);
      stellarService.readContract.mockResolvedValue({
        type: 'bool',
        value: false,
      } as any);
      const stats = await service.getStats();
      expect(stats.activeVerifiers).toBe(2);
      expect(stats).toHaveProperty('totalCredits');
      expect(stats).toHaveProperty('totalRetirements');
      expect(stats).toHaveProperty('contractPauseStatus');
      expect(stats).toHaveProperty('health');
    });

    it('#926 — contractPauseStatus is "unpaused" when probe returns false', async () => {
      stellarService.readContract.mockResolvedValue({
        type: 'bool',
        value: false,
      } as any);
      const stats = await service.getStats();
      expect(stats.contractPauseStatus).toBe('unpaused');
      expect(stats.paused).toBe(false);
      expect(stats.health.degraded).toBe(false);
    });

    it('#926 — contractPauseStatus is "paused" when probe returns true', async () => {
      // scValToNative-able truthy value
      stellarService.readContract.mockResolvedValue(
        nativeToScVal(true, { type: 'bool' }),
      );
      const stats = await service.getStats();
      expect(stats.contractPauseStatus).toBe('paused');
      expect(stats.paused).toBe(true);
      expect(stats.health.degraded).toBe(false);
    });

    it('#926 — contractPauseStatus is "unknown" and health.degraded is true when probe throws', async () => {
      stellarService.readContract.mockRejectedValue(
        new Error('Contract unavailable'),
      );
      const stats = await service.getStats();
      expect(stats.contractPauseStatus).toBe('unknown');
      // Backward-compat boolean must not claim paused when unknown
      expect(stats.paused).toBe(false);
      expect(stats.health.degraded).toBe(true);
      expect(stats.health.reason).toContain('Contract unavailable');
    });

    it('#925 — totalRetirements comes from COUNT query, not pagination', async () => {
      stellarService.readContract.mockResolvedValue({
        type: 'bool',
        value: false,
      } as any);
      mockRetirementRepo.count.mockResolvedValue(42);
      const stats = await service.getStats();
      expect(stats.totalRetirements).toBe(42);
      expect(mockRetirementRepo.count).toHaveBeenCalledTimes(1);
      expect(mockRetirementRepo.findAll).not.toHaveBeenCalled();
    });
  });

  // ── #924 — registerVerifier ────────────────────────────────────────────────

  describe('registerVerifier', () => {
    it('should call register_verifier on-chain and return registered: true', async () => {
      // Mock nonce fetch
      stellarService.readContract.mockResolvedValue(
        nativeToScVal(0n, { type: 'u64' }),
      );
      stellarService.invokeContract.mockResolvedValue({});
      const result = await service.registerVerifier('GVER1');
      expect(result).toEqual({ registered: true, address: 'GVER1' });
      expect(stellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'register_verifier',
        expect.any(Array),
        mockAdminKeypair,
      );
    });
  });

  // ── #924 — suspendVerifier ────────────────────────────────────────────────

  describe('suspendVerifier', () => {
    it('should call remove_verifier on-chain and return suspended: true', async () => {
      verifiersService.getVerifier = jest.fn().mockResolvedValue({ address: 'GVER1' });
      stellarService.readContract.mockResolvedValue(
        nativeToScVal(0n, { type: 'u64' }),
      );
      stellarService.invokeContract.mockResolvedValue({});
      const result = await service.suspendVerifier('GVER1');
      expect(result).toEqual({ suspended: true });
      expect(verifiersService.getVerifier).toHaveBeenCalledWith('GVER1');
      expect(stellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'remove_verifier',
        expect.any(Array),
        mockAdminKeypair,
      );
    });

    it('should propagate NotFoundException for unknown verifier', async () => {
      verifiersService.getVerifier = jest
        .fn()
        .mockRejectedValue(new NotFoundException());
      await expect(service.suspendVerifier('UNKNOWN')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── #924 — configureVerifier returns 501 ─────────────────────────────────

  describe('configureVerifier', () => {
    it('should throw NotImplementedException — requires verifier signature', async () => {
      await expect(
        service.configureVerifier('GVER1', { methodologies: ['VCS'] }),
      ).rejects.toThrow(NotImplementedException);
    });
  });

  // ── #924 — flagCredit returns 501 ────────────────────────────────────────

  describe('flagCredit', () => {
    it('should throw NotImplementedException — requires verifier signature', async () => {
      await expect(service.flagCredit('abc123')).rejects.toThrow(
        NotImplementedException,
      );
    });
  });

  // ── Other ─────────────────────────────────────────────────────────────────

  describe('pauseContract', () => {
    it('should invoke pause on the credit registry and return paused: true', async () => {
      const result = await service.pauseContract();
      expect(result).toEqual({ paused: true });
      expect(stellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'pause',
        expect.any(Array),
        mockAdminKeypair,
      );
    });
  });

  describe('unpauseContract', () => {
    it('should invoke unpause on the credit registry and return paused: false', async () => {
      const result = await service.unpauseContract();
      expect(result).toEqual({ paused: false });
      expect(stellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'unpause',
        expect.any(Array),
        mockAdminKeypair,
      );
    });
  });

  describe('registerMethodology', () => {
    it('should return registered: true with the provided name and description', () => {
      const result = service.registerMethodology(
        'Gold Standard',
        'Gold Standard for the Global Goals',
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
      const result = await service.setRequiredApprovals(2);
      expect(result).toEqual({ requiredApprovals: 2 });
      expect(stellarService.invokeContract).toHaveBeenCalledWith(
        expect.any(String),
        'set_required_approvals',
        expect.any(Array),
        mockAdminKeypair,
      );
    });

    it('should return requiredApprovals: 1 when threshold is 1', async () => {
      stellarService.readContract.mockResolvedValue(
        nativeToScVal(0n, { type: 'u64' }),
      );
      const result = await service.setRequiredApprovals(1);
      expect(result.requiredApprovals).toBe(1);
    });
  });
});
