import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { AdminService } from './admin.service';
import { CreditsService } from '../credits/credits.service';
import { VerifiersService } from '../verifiers/verifiers.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
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

describe('AdminService', () => {
  let service: AdminService;
  let creditsService: jest.Mocked<CreditsService>;
  let verifiersService: jest.Mocked<VerifiersService>;
  let stellarService: jest.Mocked<StellarService>;
  let keypairService: jest.Mocked<StellarKeypairService>;

  const mockAdminKeypair = Keypair.random();

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: CreditsService,
          useValue: {
            getCredit: jest.fn().mockResolvedValue(mockCredit),
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
      const result = await service.suspendVerifier('GVER1');
      expect(result).toEqual({ suspended: true });
      expect(verifiersService.getVerifier).toHaveBeenCalledWith('GVER1');
    });

    it('should propagate NotFoundException for unknown verifier', async () => {
      verifiersService.getVerifier.mockRejectedValue(new NotFoundException());
      await expect(service.suspendVerifier('UNKNOWN')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('flagCredit', () => {
    it('should return flagged: true for existing credit', async () => {
      const result = await service.flagCredit('abc123');
      expect(result).toEqual({
        flagged: true,
        creditId: 'abc123',
        status: CreditStatus.Flagged,
      });
      expect(creditsService.getCredit).toHaveBeenCalledWith('abc123');
    });

    it('should propagate NotFoundException for unknown credit', async () => {
      creditsService.getCredit.mockRejectedValue(new NotFoundException());
      await expect(service.flagCredit('UNKNOWN')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

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
      // Mock readContract to return the nonce as a u64 ScVal.
      // The service will call scValToNative → bigint → Number.
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
      // First readContract call fetches the admin nonce
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
