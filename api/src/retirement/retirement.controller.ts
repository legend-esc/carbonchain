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
  Response,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response as ExpressResponse } from 'express';
import { RetirementService, RetireDto, BatchRetireDto } from './retirement.service';
import { RetirementRecord } from '../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PageResult } from '../credits/credit.repository';
import { CertificateService } from './certificate.service';

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

  /** POST /retirement/batch — retire up to 20 credits in one call; protected: requires JWT */
  @UseGuards(JwtAuthGuard)
  @Post('batch')
  batchRetire(@Body() dto: BatchRetireDto): Promise<{ retirementIds: string[] }> {
    return this.retirementService.batchRetire(dto);
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

  /** GET /certificates/:id/download — download retirement certificate as PDF (protected: requires JWT) */
  @UseGuards(JwtAuthGuard)
  @Get('certificates/:id/download')
  async downloadCertificate(
    @Param('id') certificateId: string,
    @Response() res: ExpressResponse,
  ): Promise<void> {
    // Retrieve the retirement record to ensure it exists
    const retirement = await this.retirementService.getRetirement(certificateId);
    if (!retirement) {
      throw new NotFoundException(
        `Retirement record ${certificateId} not found`,
      );
    }

    // Generate the PDF
    const pdfBuffer = await this.certificateService.generatePdf({
      retirementId: certificateId,
      creditId: retirement.credit_id,
      buyer: retirement.buyer,
      tonnes: retirement.tonnes_retired,
      reason: retirement.reason,
      timestamp: retirement.retired_at,
    });

    // Set response headers and stream the PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="certificate-${certificateId}.pdf"`,
    );
    res.send(pdfBuffer);
  }

  /** GET /certificates/:id/verify — verify retirement certificate authenticity (public) */
  @Get('certificates/:id/verify')
  verifyCertificate(
    @Param('id') certificateId: string,
  ): Promise<CertificateVerification> {
    return this.retirementService.verifyCertificate(certificateId);
  }
}
