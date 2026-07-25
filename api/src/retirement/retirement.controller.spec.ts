import { Test, TestingModule } from '@nestjs/testing';
import { StreamableFile, NotFoundException } from '@nestjs/common';
import { RetirementController } from './retirement.controller';
import { RetirementService } from './retirement.service';
import { CertificateService } from './certificate.service';
import { RetirementRecord } from '../shared';

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

describe('RetirementController', () => {
  let controller: RetirementController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RetirementController],
      providers: [
        { provide: RetirementService, useValue: mockRetirementService },
        { provide: CertificateService, useValue: mockCertificateService },
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
      const options = (result as StreamableFile).getHeaders();
      expect(options['content-type']).toBe('application/pdf');
      expect(options['content-disposition']).toBe(
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

      await expect(controller.downloadCertificate(retirementId)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockRetirementService.getRetirement).toHaveBeenCalledWith(retirementId);
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

      await expect(controller.downloadCertificate(retirementId)).rejects.toThrow(
        'PDF generation failed',
      );
    });

    it('should not use @Res() — method signature has no Response parameter', () => {
      // Verify the handler accepts only `certificateId` (no raw Response injection).
      const paramLength = controller.downloadCertificate.length;
      expect(paramLength).toBe(1);
    });
  });
});
