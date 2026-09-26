import { StreamableFile, NotFoundException } from '@nestjs/common';
import { CertificatesController } from './certificates.controller';
import {
  RetirementService,
  CertificateVerification,
} from './retirement.service';
import { CertificateService } from './certificate.service';
import { RetirementRecord } from '../../../shared';
import { CertificateResponseDto } from './dto/certificate-response.dto';

function makeRetirement(
  id: string,
  overrides: Partial<RetirementRecord> = {},
): RetirementRecord {
  return {
    id,
    credit_id: 'CREDIT1',
    buyer: 'GBUYER',
    tonnes_retired: '100',
    reason: 'offset',
    retired_at: 1700000000,
    tx_hash: 'TX',
    vintage_year: 2024,
    ...overrides,
  };
}

function makeVerification(
  overrides: Partial<CertificateVerification> = {},
): CertificateVerification {
  return {
    id: 'R1',
    credit_id: 'CREDIT1',
    buyer: 'GBUYER',
    tonnes_retired: '100',
    reason: 'offset',
    retired_at: 1700000000,
    tx_hash: 'TX',
    verified: true,
    certificate_ipfs_hash: 'bafybeiabc123',
    ...overrides,
  };
}

describe('CertificatesController', () => {
  let controller: CertificatesController;
  let retirementService: jest.Mocked<Partial<RetirementService>>;
  let certificateService: jest.Mocked<Partial<CertificateService>>;

  beforeEach(() => {
    retirementService = {
      getRetirement: jest.fn(),
      verifyCertificate: jest.fn(),
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
    it('returns a CertificateResponseDto with mapped fields', async () => {
      const record = makeRetirement('R1', { certificate_ipfs_hash: 'Qm123' });
      retirementService.getRetirement.mockResolvedValue(record);

      const result = await controller.getCertificate('R1');

      expect(result).toBeInstanceOf(CertificateResponseDto);
      expect(result.id).toBe('R1');
      expect(result.credit_id).toBe('CREDIT1');
      expect(result.buyer).toBe('GBUYER');
      expect(result.tonnes_retired).toBe('100');
      expect(result.reason).toBe('offset');
      expect(result.retired_at).toBe(1700000000);
      expect(result.tx_hash).toBe('TX');
      expect(result.vintage_year).toBe(2024);
      expect(result.certificate_ipfs_hash).toBe('Qm123');
      expect(retirementService.getRetirement).toHaveBeenCalledWith('R1');
    });

    /**
     * Issue #943 — getCertificate must expose ledgerSeq from the retirement
     * record so the API consumer can verify the retirement against the ledger.
     */
    it('exposes ledgerSeq from the on-chain retirement record (issue #943)', async () => {
      const record = makeRetirement('R2', { ledger_seq: 55_123_456 });
      retirementService.getRetirement.mockResolvedValue(record);

      const result = await controller.getCertificate('R2');

      expect(result.ledgerSeq).toBe(55_123_456);
    });

    it('sets ledgerSeq to null for legacy records without ledger_seq (issue #943)', async () => {
      // Legacy record — no ledger_seq field at all.
      const record = makeRetirement('R3');
      retirementService.getRetirement.mockResolvedValue(record);

      const result = await controller.getCertificate('R3');

      expect(result.ledgerSeq).toBeNull();
    });

    it('sets ledgerSeq to null when ledger_seq is 0 (legacy default)', async () => {
      const record = makeRetirement('R4', { ledger_seq: 0 });
      retirementService.getRetirement.mockResolvedValue(record);

      const result = await controller.getCertificate('R4');

      // 0 is treated as "no anchor" for backward compatibility.
      expect(result.ledgerSeq).toBeNull();
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

  // ── #936 — verifyCertificate endpoint ──────────────────────────────────────

  describe('verifyCertificate', () => {
    it('returns verified=true with reason="ok" for an untampered certificate', async () => {
      retirementService.verifyCertificate.mockResolvedValue(
        makeVerification({
          verified: true,
          certificate_ipfs_hash: 'bafybeiabc123',
        }),
      );

      const result = await controller.verifyCertificate('R1');

      expect(result.verified).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.certificate_ipfs_hash).toBe('bafybeiabc123');
      expect(retirementService.verifyCertificate).toHaveBeenCalledWith('R1');
    });

    it('returns verified=false with reason="notOnChain" when no hash is registered', async () => {
      retirementService.verifyCertificate.mockResolvedValue(
        makeVerification({ verified: false, certificate_ipfs_hash: '' }),
      );

      const result = await controller.verifyCertificate('R1');

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('notOnChain');
    });

    it('returns verified=false with reason="notOnChain" when hash is undefined', async () => {
      retirementService.verifyCertificate.mockResolvedValue(
        makeVerification({ verified: false, certificate_ipfs_hash: undefined }),
      );

      const result = await controller.verifyCertificate('R1');

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('notOnChain');
    });

    it('returns verified=false with reason="contentMismatch" for a tampered certificate', async () => {
      // Hash is present but the content did not match the on-chain hash.
      retirementService.verifyCertificate.mockResolvedValue(
        makeVerification({
          verified: false,
          certificate_ipfs_hash: 'bafybeiabc123',
        }),
      );

      const result = await controller.verifyCertificate('R1');

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('contentMismatch');
    });

    it('propagates NotFoundException from retirementService', async () => {
      retirementService.verifyCertificate.mockRejectedValue(
        new NotFoundException('Certificate R1 not found or cannot be verified'),
      );

      await expect(controller.verifyCertificate('R1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('includes all retirement fields in the response', async () => {
      const verification = makeVerification({
        verified: true,
        certificate_ipfs_hash: 'bafybeiabc123',
      });
      retirementService.verifyCertificate.mockResolvedValue(verification);

      const result = await controller.verifyCertificate('R1');

      expect(result.id).toBe('R1');
      expect(result.credit_id).toBe('CREDIT1');
      expect(result.buyer).toBe('GBUYER');
      expect(result.tonnes_retired).toBe('100');
      expect(result.reason).toBe('offset');
      expect(result.retired_at).toBe(1700000000);
      expect(result.tx_hash).toBe('TX');
    });
  });
});
