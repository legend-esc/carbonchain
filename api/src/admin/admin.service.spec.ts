import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { CreditsService } from '../credits/credits.service';
import { VerifiersService } from '../verifiers/verifiers.service';
import { CreditStatus } from '../shared';

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
      ],
    }).compile();

    service = module.get(AdminService);
    creditsService = module.get(CreditsService);
    verifiersService = module.get(VerifiersService);
  });

  describe('getStats', () => {
    it('should return stats with active verifier count', async () => {
      const stats = await service.getStats();
      expect(stats.activeVerifiers).toBe(2);
      expect(stats).toHaveProperty('totalCredits');
      expect(stats).toHaveProperty('totalRetirements');
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
      const result = service.registerMethodology('CDM', 'Clean Development Mechanism');
      expect(result.name).toBe('CDM');
      expect(result.description).toBe('Clean Development Mechanism');
    });
  });

  describe('getNonce', () => {
    it('should return a nonce object with the requested address', () => {
      const result = service.getNonce('GADMINPUBLICKEY');
      expect(result.address).toBe('GADMINPUBLICKEY');
      expect(typeof result.nonce).toBe('number');
    });
  });

  describe('setRequiredApprovals', () => {
    it('should return the threshold that was set', () => {
      const result = service.setRequiredApprovals(2);
      expect(result).toEqual({ requiredApprovals: 2 });
    });

    it('should return 1 when threshold is 1', () => {
      const result = service.setRequiredApprovals(1);
      expect(result.requiredApprovals).toBe(1);
    });
  });
});
