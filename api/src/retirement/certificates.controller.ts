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
import { RetirementService } from './retirement.service';
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
