import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VerifiersController } from './verifiers.controller';
import { VerifiersService } from './verifiers.service';
import { VerifierReputation } from '../../../shared';

// ── Minimal mock for VerifiersService ─────────────────────────────────────────
const VALID_ADDRESS =
  'GBCI2DH7MEKQUTCXZ7YLEVOZHDMBWPCMB6V46ZQHOUN2BHBWRWYY2JRP';
const UNKNOWN_ADDRESS =
  'GAGMTFWZSEDGZ6GQWDDA3QOW54BQE3GEIVSIVZHY6KOHQ4WY26F7VOL7';
const INVALID_ADDRESS = 'not-a-stellar-address';

const mockVerifiersService = {
  listVerifiers: jest.fn(),
  getVerifier: jest.fn(),
  getPendingCredits: jest.fn(),
  getApprovalHistory: jest.fn(),
  approveCredit: jest.fn(),
  getReputation: jest.fn(),
};

describe('VerifiersController', () => {
  let controller: VerifiersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VerifiersController],
      providers: [
        { provide: VerifiersService, useValue: mockVerifiersService },
      ],
    }).compile();

    controller = module.get<VerifiersController>(VerifiersController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── GET :address/reputation ───────────────────────────────────────────────

  describe('getReputation', () => {
    it('returns HTTP 200 with reputation for a known verifier', async () => {
      const reputation: VerifierReputation = {
        address: VALID_ADDRESS,
        approvalCount: 5,
        disputeCount: 1,
      };
      mockVerifiersService.getReputation.mockResolvedValueOnce(reputation);

      const result = await controller.getReputation(VALID_ADDRESS);

      expect(mockVerifiersService.getReputation).toHaveBeenCalledWith(
        VALID_ADDRESS,
      );
      expect(result).toEqual(reputation);
    });

    it('returns HTTP 400 (BadRequestException) for an invalid Stellar address', async () => {
      await expect(controller.getReputation(INVALID_ADDRESS)).rejects.toThrow(
        BadRequestException,
      );
      // Service must NOT be called — the guard should fire first
      expect(mockVerifiersService.getReputation).not.toHaveBeenCalled();
    });

    it('returns HTTP 400 for an empty string address', async () => {
      await expect(controller.getReputation('')).rejects.toThrow(
        BadRequestException,
      );
      expect(mockVerifiersService.getReputation).not.toHaveBeenCalled();
    });

    it('propagates HTTP 404 from the service for an unknown verifier', async () => {
      mockVerifiersService.getReputation.mockRejectedValueOnce(
        new NotFoundException(`Verifier ${UNKNOWN_ADDRESS} not found`),
      );

      await expect(controller.getReputation(UNKNOWN_ADDRESS)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('includes the address in the response payload', async () => {
      const reputation: VerifierReputation = {
        address: VALID_ADDRESS,
        approvalCount: 10,
        disputeCount: 0,
      };
      mockVerifiersService.getReputation.mockResolvedValueOnce(reputation);

      const result = await controller.getReputation(VALID_ADDRESS);
      expect(result.address).toBe(VALID_ADDRESS);
      expect(result.approvalCount).toBe(10);
      expect(result.disputeCount).toBe(0);
    });
  });
});
