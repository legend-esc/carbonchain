import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  NotFoundException,
  StreamableFile,
  Header,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RetirementService, RetireDto } from './retirement.service';
import { RetirementRecord } from '../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PageResult } from '../credits/credit.repository';
import { CertificateService } from './certificate.service';
import { Throttle } from '../common/throttler.guard';

export interface CertificateVerification {
  id: string;
  credit_id: string;
  buyer: string;
  tonnes_retired: string;
  reason: string;
  retired_at: number;
  tx_hash: string;
  verified: boolean;
  ledger_sequence?: number;
}

@ApiTags('retirement')
@Controller('retirement')
export class RetirementController {
  constructor(
    private readonly retirementService: RetirementService,
    private readonly certificateService: CertificateService,
  ) {}

  /** POST /retirement — protected: requires JWT */
  @UseGuards(JwtAuthGuard)
  @Post()
  retire(
    @Body() dto: RetireDto,
  ): Promise<{ retirementId: string; certificateIpfsHash: string }> {
    return this.retirementService.retire(dto);
  }

  /** GET /retirement — paginated list */
  @Get()
  listRetirements(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<PageResult<RetirementRecord>> {
    return this.retirementService.listRetirements(page, limit);
  }

  /** GET /retirement/:id — fetch a retirement record */
  @Get(':id')
  getRetirement(@Param('id') id: string): Promise<RetirementRecord> {
    return this.retirementService.getRetirement(id);
  }

  /** GET /retirement/account/:address — paginated retirements for an account */
  @Get('account/:address')
  getByAccount(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<PageResult<RetirementRecord>> {
    return this.retirementService.getRetirementsByAccount(address, page, limit);
  }

  /**
   * GET /retirement/:id/certificate — stream retirement certificate as PDF.
   *
   * Uses `StreamableFile` so NestJS interceptors remain active (no raw `@Res()`).
   * Rate limited to 10 downloads per user per minute to bound CPU usage from
   * the synchronous PDF generation worker.
   *
   * Response headers:
   *   Content-Type: application/pdf
   *   Content-Disposition: attachment; filename="retirement-certificate-<id>.pdf"
   */
  @UseGuards(JwtAuthGuard)
  @Throttle({ limit: 10, ttl: 60_000 })
  @Get(':id/certificate')
  @Header('Content-Type', 'application/pdf')
  async downloadCertificate(
    @Param('id') certificateId: string,
  ): Promise<StreamableFile> {
    // Retrieve the retirement record — throws NotFoundException if absent.
    const retirement = await this.retirementService.getRetirement(certificateId);
    if (!retirement) {
      throw new NotFoundException(
        `Retirement record ${certificateId} not found`,
      );
    }

    // Generate the PDF buffer (CPU-intensive; bounded by worker thread pool).
    const pdfBuffer = await this.certificateService.generatePdf({
      retirementId: certificateId,
      creditId: retirement.credit_id,
      buyer: retirement.buyer,
      tonnes: retirement.tonnes_retired,
      reason: retirement.reason,
      timestamp: retirement.retired_at,
    });

    return new StreamableFile(pdfBuffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="retirement-certificate-${certificateId}.pdf"`,
    });
  }

  /** GET /certificates/:id/verify — verify retirement certificate authenticity (public) */
  @Get('certificates/:id/verify')
  verifyCertificate(
    @Param('id') certificateId: string,
  ): Promise<CertificateVerification> {
    return this.retirementService.verifyCertificate(certificateId);
  }
}
