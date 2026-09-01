import { StreamableFile, NotFoundException } from '@nestjs/common';
import { CertificatesController } from './certificates.controller';
import { RetirementService } from './retirement.service';
import { CertificateService } from './certificate.service';
import { RetirementRecord } from '../../../shared';

function makeRetirement(id: string): RetirementRecord {
  return {
    id,
    credit_id: 'CREDIT1',
    buyer: 'GBUYER',
    tonnes_retired: '100',
    reason: 'offset',
    retired_at: 1700000000,
    tx_hash: 'TX',
    vintage_year: 2024,
  };
}

describe('CertificatesController', () => {
  let controller: CertificatesController;
  let retirementService: jest.Mocked<Partial<RetirementService>>;
  let certificateService: jest.Mocked<Partial<CertificateService>>;

  beforeEach(() => {
    retirementService = {
      getRetirement: jest.fn(),
    };
    certificateService = {
      generatePdf: jest.fn(),
    };
    controller = new CertificatesController(
      retirementService as any,
      certificateService as any,
    );
  });

  describe('getCertificate', () => {
    it('returns the retirement record by id', async () => {
      const record = makeRetirement('R1');
      retirementService.getRetirement.mockResolvedValue(record);
      await expect(controller.getCertificate('R1')).resolves.toBe(record);
      expect(retirementService.getRetirement).toHaveBeenCalledWith('R1');
    });
  });

  describe('downloadCertificate', () => {
    const pdfBuffer = Buffer.from('%PDF-1.4');

    it('returns a StreamableFile when the retirement exists', async () => {
      retirementService.getRetirement.mockResolvedValue(makeRetirement('R1'));
      certificateService.generatePdf.mockResolvedValue(pdfBuffer);

      const result = await controller.downloadCertificate('R1');

      expect(result).toBeInstanceOf(StreamableFile);
      expect(certificateService.generatePdf).toHaveBeenCalled();
    });

    it('throws NotFoundException when the retirement is missing', async () => {
      retirementService.getRetirement.mockResolvedValue(undefined);
      await expect(controller.downloadCertificate('R1')).rejects.toThrow(
        NotFoundException,
      );
      expect(certificateService.generatePdf).not.toHaveBeenCalled();
    });
  });
});
