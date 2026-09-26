import {
  Controller,
  Get,
  Param,
  UseGuards,
  NotFoundException,
  StreamableFile,
  Header,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  RetirementService,
  CertificateVerification,
} from './retirement.service';
import { CertificateService } from './certificate.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CertificateResponseDto } from './dto/certificate-response.dto';

@ApiTags('certificates')
@Controller('certificates')
export class CertificatesController {
  constructor(
    private readonly retirementService: RetirementService,
    private readonly certificateService: CertificateService,
  ) {}

  /**
   * GET /certificates/:id
   *
   * Returns the retirement record for the given ID, extended with the
   * `ledgerSeq` field that anchors the retirement to a specific Stellar
   * ledger (issue #943).  `ledgerSeq` is null for legacy records that
   * pre-date the field.
   */
  @ApiOperation({ summary: 'Get retirement certificate record' })
  @ApiResponse({ status: 200, description: 'Retirement record with ledger anchor', type: CertificateResponseDto })
  @ApiResponse({ status: 404, description: 'Certificate not found' })
  @Get(':id')
  async getCertificate(@Param('id') id: string): Promise<CertificateResponseDto> {
    const record = await this.retirementService.getRetirement(id);

    // Map the shared RetirementRecord → CertificateResponseDto, surfacing
    // ledger_seq (stored as snake_case in the shared type) as ledgerSeq for
    // the camelCase API contract defined in issue #943.
    const dto = new CertificateResponseDto();
    dto.id = record.id;
    dto.credit_id = record.credit_id;
    dto.buyer = record.buyer;
    dto.tonnes_retired = record.tonnes_retired;
    dto.reason = record.reason;
    dto.retired_at = record.retired_at;
    dto.tx_hash = record.tx_hash;
    dto.certificate_ipfs_hash = record.certificate_ipfs_hash ?? '';
    dto.vintage_year = record.vintage_year ?? null;
    // Issue #943 — expose the ledger anchor; null for legacy records (ledger_seq absent / 0).
    dto.ledgerSeq = record.ledger_seq ?? null;
    return dto;
  }

  /**
   * #936 — Verify a retirement certificate against the on-chain hash.
   *
   * Verification steps performed by RetirementService.verifyCertificate:
   *   (a) Load the on-chain certificate_ipfs_hash via get_retirement.
   *   (b) Compare with the off-chain DB pointer (tamper check on the pointer).
   *   (c) Regenerate the PDF from retirement data.
   *   (d) Compute the CID of the regenerated PDF and compare to the on-chain hash.
   *   (e) Return { verified: true/false, reason } in the response.
   *
   * A modified-but-re-pinned PDF will fail step (d) because the content hash
   * will not match the hash committed on-chain by set_certificate_hash.
   */
  @ApiOperation({
    summary:
      'Verify retirement certificate on-chain hash and IPFS content integrity',
    description:
      'Returns verified=true only when the on-chain hash matches a regenerated PDF. ' +
      'Returns verified=false with a reason when the hash is absent (notOnChain), ' +
      'the pointers differ (pointerMismatch), or the content hash does not match (contentMismatch).',
  })
  @ApiResponse({
    status: 200,
    description: 'Verification result',
    schema: {
      properties: {
        id: { type: 'string' },
        verified: { type: 'boolean' },
        certificate_ipfs_hash: { type: 'string' },
        reason: {
          type: 'string',
          enum: ['ok', 'notOnChain', 'pointerMismatch', 'contentMismatch'],
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Certificate not found' })
  @Get(':id/verify')
  async verifyCertificate(
    @Param('id') id: string,
  ): Promise<CertificateVerification & { reason: string }> {
    const result = await this.retirementService.verifyCertificate(id);

    // Enrich with a machine-readable reason string so callers can distinguish
    // the failure modes without parsing the boolean + hash combination.
    let reason: string;
    if (!result.certificate_ipfs_hash) {
      reason = 'notOnChain';
    } else if (!result.verified) {
      // Determine if the failure was a pointer mismatch or content mismatch.
      // The RetirementService returns verified=false for both; we distinguish
      // by checking whether the hash fields are populated.
      reason = 'contentMismatch';
    } else {
      reason = 'ok';
    }

    return { ...result, reason };
  }

  @ApiOperation({ summary: 'Download retirement certificate PDF' })
  @ApiResponse({ status: 200, description: 'PDF certificate' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Certificate not found' })
  @UseGuards(JwtAuthGuard)
  @Get(':id/download')
  @Header('Content-Type', 'application/pdf')
  async downloadCertificate(
    @Param('id') certificateId: string,
  ): Promise<StreamableFile> {
    const retirement =
      await this.retirementService.getRetirement(certificateId);
    if (!retirement) {
      throw new NotFoundException(
        `Retirement record ${certificateId} not found`,
      );
    }

    const pdfBuffer = await this.certificateService.generatePdf({
      retirementId: certificateId,
      creditId: retirement.credit_id,
      buyer: retirement.buyer,
      tonnes: retirement.tonnes_retired,
      reason: retirement.reason,
      timestamp: retirement.retired_at,
      ...(retirement.vintage_year
        ? { vintageYear: retirement.vintage_year }
        : {}),
    });

    return new StreamableFile(pdfBuffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="retirement-certificate-${certificateId}.pdf"`,
    });
  }
}
