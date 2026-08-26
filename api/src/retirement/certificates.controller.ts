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
