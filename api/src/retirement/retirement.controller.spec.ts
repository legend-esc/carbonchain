import { Test, TestingModule } from '@nestjs/testing';
import { RetirementController } from './retirement.controller';
import { RetirementService } from './retirement.service';
import { CertificateService } from './certificate.service';
import { NotFoundException } from '@nestjs/common';
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
  let retirementService: RetirementService;
  let certificateService: CertificateService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RetirementController],
      providers: [
        { provide: RetirementService, useValue: mockRetirementService },
        { provide: CertificateService, useValue: mockCertificateService },
      ],
    }).compile();

    controller = module.get<RetirementController>(RetirementController);
    retirementService = module.get<RetirementService>(RetirementService);
    certificateService = module.get<CertificateService>(CertificateService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('downloadCertificate', () => {
    it('should generate and return PDF with correct headers', async () => {
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

      mockRetirementService.getRetirement.mockResolvedValueOnce(
        mockRetirement,
      );
      mockCertificateService.generatePdf.mockResolvedValueOnce(mockPdfBuffer);

      const mockResponse = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as any;

      await controller.downloadCertificate(retirementId, mockResponse);

      expect(mockRetirementService.getRetirement).toHaveBeenCalledWith(
        retirementId,
      );
      expect(mockCertificateService.generatePdf).toHaveBeenCalledWith({
        retirementId,
        creditId: mockRetirement.credit_id,
        buyer: mockRetirement.buyer,
        tonnes: mockRetirement.tonnes_retired,
        reason: mockRetirement.reason,
        timestamp: mockRetirement.retired_at,
      });
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/pdf',
      );
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        `attachment; filename="certificate-${retirementId}.pdf"`,
      );
      expect(mockResponse.send).toHaveBeenCalledWith(mockPdfBuffer);
    });

    it('should throw NotFoundException when retirement not found', async () => {
      const retirementId = 'non-existent-id';

      mockRetirementService.getRetirement.mockResolvedValueOnce(null);

      const mockResponse = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as any;

      await expect(
        controller.downloadCertificate(retirementId, mockResponse),
      ).rejects.toThrow(NotFoundException);
      expect(mockRetirementService.getRetirement).toHaveBeenCalledWith(
        retirementId,
      );
    });

    it('should handle certificate generation errors gracefully', async () => {
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

      mockRetirementService.getRetirement.mockResolvedValueOnce(
        mockRetirement,
      );
      mockCertificateService.generatePdf.mockRejectedValueOnce(
        new Error('PDF generation failed'),
      );

      const mockResponse = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as any;

      await expect(
        controller.downloadCertificate(retirementId, mockResponse),
      ).rejects.toThrow('PDF generation failed');
    });
  });
});
