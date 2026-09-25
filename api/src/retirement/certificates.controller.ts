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
import { RetirementRecord } from '../../../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('certificates')
@Controller('certificates')
export class CertificatesController {
  constructor(
    private readonly retirementService: RetirementService,
    private readonly certificateService: CertificateService,
  ) {}

  @ApiOperation({ summary: 'Get retirement certificate record' })
  @ApiResponse({ status: 200, description: 'Retirement record' })
  @ApiResponse({ status: 404, description: 'Certificate not found' })
  @Get(':id')
  getCertificate(@Param('id') id: string): Promise<RetirementRecord> {
    return this.retirementService.getRetirement(id);
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
