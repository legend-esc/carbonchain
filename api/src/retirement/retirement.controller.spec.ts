import { Test, TestingModule } from '@nestjs/testing';
import { StreamableFile, NotFoundException, BadRequestException } from '@nestjs/common';
import { RetirementController } from './retirement.controller';
import { RetirementService } from './retirement.service';
import { CertificateService } from './certificate.service';
import { RetirementRecord } from '../../../shared';
import { StellarAddressPipe } from '../common/pipes/stellar-address.pipe';

const mockRetirementService = {
  retire: jest.fn(),
  getRetirement: jest.fn(),
  listRetirements: jest.fn(),
  getRetirementsByAccount: jest.fn(),
  verifyCertificate: jest.fn(),
};

const mockCertificateService = {
  generateAndPin: jest.fn(),
  generatePdf: jest.fn(),
};

// A valid Stellar ed25519 public key (G + 55 base32 chars, 56 total).
const VALID_STELLAR_ADDRESS =
  'GBSOK5REZRYMHX5ZJNDZUPUKLDVSAXTJ6D5OKXWOEENUTLZHOP2TWZDY';

describe('RetirementController', () => {
  let controller: RetirementController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RetirementController],
      providers: [
        { provide: RetirementService, useValue: mockRetirementService },
        { provide: CertificateService, useValue: mockCertificateService },
        StellarAddressPipe,
      ],
    }).compile();

    controller = module.get<RetirementController>(RetirementController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('downloadCertificate', () => {
    it('should return a StreamableFile with correct type and disposition', async () => {
      const retirementId = 'test-retirement-id';
      const mockRetirement: RetirementRecord = {
        id: retirementId,
        credit_id: 'credit-123',
        buyer: 'buyer-address',
        tonnes_retired: '1000000',
        reason: 'Testing',
        retired_at: 1234567890,
        tx_hash: 'hash-123',
      };
      const mockPdfBuffer = Buffer.from('PDF content');

      mockRetirementService.getRetirement.mockResolvedValueOnce(mockRetirement);
      mockCertificateService.generatePdf.mockResolvedValueOnce(mockPdfBuffer);

      const result = await controller.downloadCertificate(retirementId);

      expect(result).toBeInstanceOf(StreamableFile);
      // Verify the StreamableFile carries the correct metadata.
      const options = result.getHeaders();
      expect(options['type']).toBe('application/pdf');
      expect(options['disposition']).toBe(
        `attachment; filename="retirement-certificate-${retirementId}.pdf"`,
      );
    });

    it('should call generatePdf with the correct CertificateData', async () => {
      const retirementId = 'abc-123';
      const mockRetirement: RetirementRecord = {
        id: retirementId,
        credit_id: 'credit-456',
        buyer: 'GBUYER',
        tonnes_retired: '2000000',
        reason: 'Scope 3',
        retired_at: 9999999,
        tx_hash: 'txhash',
      };
      const mockPdfBuffer = Buffer.from('%PDF-1.4');

      mockRetirementService.getRetirement.mockResolvedValueOnce(mockRetirement);
      mockCertificateService.generatePdf.mockResolvedValueOnce(mockPdfBuffer);

      await controller.downloadCertificate(retirementId);

      expect(mockCertificateService.generatePdf).toHaveBeenCalledWith({
        retirementId,
        creditId: mockRetirement.credit_id,
        buyer: mockRetirement.buyer,
        tonnes: mockRetirement.tonnes_retired,
        reason: mockRetirement.reason,
        timestamp: mockRetirement.retired_at,
      });
    });

    it('should throw NotFoundException when retirement is not found', async () => {
      const retirementId = 'non-existent-id';

      // Service returns null to simulate a missing record.
      mockRetirementService.getRetirement.mockResolvedValueOnce(null);

      await expect(
        controller.downloadCertificate(retirementId),
      ).rejects.toThrow(NotFoundException);
      expect(mockRetirementService.getRetirement).toHaveBeenCalledWith(
        retirementId,
      );
      expect(mockCertificateService.generatePdf).not.toHaveBeenCalled();
    });

    it('should propagate errors from generatePdf', async () => {
      const retirementId = 'test-id';
      const mockRetirement: RetirementRecord = {
        id: retirementId,
        credit_id: 'credit-123',
        buyer: 'buyer-address',
        tonnes_retired: '1000000',
        reason: 'Testing',
        retired_at: 1234567890,
        tx_hash: 'hash-123',
      };

      mockRetirementService.getRetirement.mockResolvedValueOnce(mockRetirement);
      mockCertificateService.generatePdf.mockRejectedValueOnce(
        new Error('PDF generation failed'),
      );

      await expect(
        controller.downloadCertificate(retirementId),
      ).rejects.toThrow('PDF generation failed');
    });

    it('should not use @Res() — method signature has no Response parameter', () => {
      // Verify the handler accepts only `certificateId` (no raw Response injection).
      const paramLength = controller.downloadCertificate.length;
      expect(paramLength).toBe(1);
    });
  });

  // === listRetirements — limit clamping

  describe('listRetirements — limit clamping', () => {
    const pageResult = { data: [], total: 0, page: 1, limit: 20 };

    it('passes an in-range limit unchanged', async () => {
      mockRetirementService.listRetirements.mockResolvedValueOnce(pageResult);
      await controller.listRetirements(1, 20);
      expect(mockRetirementService.listRetirements).toHaveBeenCalledWith(1, 20);
    });

    it('clamps limit above 100 down to 100', async () => {
      mockRetirementService.listRetirements.mockResolvedValueOnce(pageResult);
      await controller.listRetirements(1, 9999);
      expect(mockRetirementService.listRetirements).toHaveBeenCalledWith(1, 100);
    });

    it('clamps limit of 0 up to 1', async () => {
      mockRetirementService.listRetirements.mockResolvedValueOnce(pageResult);
      await controller.listRetirements(1, 0);
      expect(mockRetirementService.listRetirements).toHaveBeenCalledWith(1, 1);
    });

    it('clamps a negative limit up to 1', async () => {
      mockRetirementService.listRetirements.mockResolvedValueOnce(pageResult);
      await controller.listRetirements(1, -50);
      expect(mockRetirementService.listRetirements).toHaveBeenCalledWith(1, 1);
    });
  });

  // === getByAccount — limit clamping + Stellar address validation

  describe('getByAccount — limit clamping', () => {
    const pageResult = { data: [], total: 0, page: 1, limit: 20 };

    it('passes an in-range limit unchanged', async () => {
      mockRetirementService.getRetirementsByAccount.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getByAccount(VALID_STELLAR_ADDRESS, 1, 20);
      expect(
        mockRetirementService.getRetirementsByAccount,
      ).toHaveBeenCalledWith(VALID_STELLAR_ADDRESS, 1, 20);
    });

    it('clamps limit above 100 down to 100', async () => {
      mockRetirementService.getRetirementsByAccount.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getByAccount(VALID_STELLAR_ADDRESS, 1, 500);
      expect(
        mockRetirementService.getRetirementsByAccount,
      ).toHaveBeenCalledWith(VALID_STELLAR_ADDRESS, 1, 100);
    });

    it('clamps limit of 0 up to 1', async () => {
      mockRetirementService.getRetirementsByAccount.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getByAccount(VALID_STELLAR_ADDRESS, 1, 0);
      expect(
        mockRetirementService.getRetirementsByAccount,
      ).toHaveBeenCalledWith(VALID_STELLAR_ADDRESS, 1, 1);
    });

    it('clamps a negative limit up to 1', async () => {
      mockRetirementService.getRetirementsByAccount.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getByAccount(VALID_STELLAR_ADDRESS, 1, -10);
      expect(
        mockRetirementService.getRetirementsByAccount,
      ).toHaveBeenCalledWith(VALID_STELLAR_ADDRESS, 1, 1);
    });
  });

  describe('getByAccount — StellarAddressPipe', () => {
    it('accepts a valid Stellar address', async () => {
      mockRetirementService.getRetirementsByAccount.mockResolvedValueOnce({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
      });

      // The pipe runs at the framework level; calling the method directly with
      // a pre-validated value verifies the happy path reaches the service.
      await controller.getByAccount(VALID_STELLAR_ADDRESS, 1, 20);
      expect(
        mockRetirementService.getRetirementsByAccount,
      ).toHaveBeenCalledWith(VALID_STELLAR_ADDRESS, 1, 20);
    });

    it('StellarAddressPipe throws BadRequestException for a junk string', () => {
      const pipe = new StellarAddressPipe();
      expect(() => pipe.transform('not-a-stellar-key')).toThrow(
        BadRequestException,
      );
    });

    it('StellarAddressPipe throws BadRequestException for an empty string', () => {
      const pipe = new StellarAddressPipe();
      expect(() => pipe.transform('')).toThrow(BadRequestException);
    });

    it('StellarAddressPipe accepts a valid key', () => {
      const pipe = new StellarAddressPipe();
      expect(pipe.transform(VALID_STELLAR_ADDRESS)).toBe(VALID_STELLAR_ADDRESS);
    });

    it('StellarAddressPipe rejects an address starting with S (secret key)', () => {
      const pipe = new StellarAddressPipe();
      // Stellar secret keys start with S, not G — must be rejected.
      expect(() =>
        pipe.transform('SCZANGBA5RLKJSZDFNHH36MYQC5B5D53F2LHWKDV7Q4DGZCRDNZNMZW'),
      ).toThrow(BadRequestException);
    });
  });
});
