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
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response as ExpressResponse } from 'express';
import {
  RetirementService,
  FullRetireDto,
  BatchRetireResult,
} from './retirement.service';
import { BatchRetireDto } from './dto/batch-retire.dto';
import { RetirementRecord } from '../../../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ThrottlerGuard, Throttle } from '../common/throttler.guard';
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

  @ApiOperation({ summary: 'Retire a carbon credit' })
  @ApiResponse({ status: 201, description: 'Credit retired successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post()
  retire(
    @Body() dto: FullRetireDto,
  ): Promise<{ retirementId: string; certificateIpfsHash: string }> {
    return this.retirementService.retire(dto);
  }

  @ApiOperation({ summary: 'Batch retire multiple credits at once' })
  @ApiResponse({ status: 201, description: 'Credits retired in batch' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 429, description: 'Too Many Requests' })
  @Throttle({ limit: 5, ttl: 60000 })
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Post('batch')
  batchRetire(@Body() dto: BatchRetireDto): Promise<BatchRetireResult> {
    return this.retirementService.batchRetire(dto);
  }

  @ApiOperation({ summary: 'List retirements (paginated)' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of retirement records',
  })
  @Get()
  listRetirements(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<PageResult<RetirementRecord>> {
    return this.retirementService.listRetirements(page, limit);
  }

  @ApiOperation({ summary: 'Get retirement record by ID' })
  @ApiResponse({ status: 200, description: 'Retirement record' })
  @ApiResponse({ status: 404, description: 'Retirement not found' })
  @Get(':id')
  getRetirement(@Param('id') id: string): Promise<RetirementRecord> {
    return this.retirementService.getRetirement(id);
  }

  @ApiOperation({ summary: 'Get retirements by account address' })
  @ApiResponse({
    status: 200,
    description: 'Paginated retirements for account',
  })
  @Get('account/:address')
  getByAccount(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<PageResult<RetirementRecord>> {
    return this.retirementService.getRetirementsByAccount(address, page, limit);
  }

  @ApiOperation({ summary: 'Download retirement certificate as PDF' })
  @ApiResponse({ status: 200, description: 'PDF certificate' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Certificate not found' })
  @UseGuards(JwtAuthGuard)
  @Get('certificates/:id/download')
  async downloadCertificate(
    @Param('id') certificateId: string,
    @Response() res: ExpressResponse,
  ): Promise<void> {
    // Retrieve the retirement record to ensure it exists
    const retirement =
      await this.retirementService.getRetirement(certificateId);
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

  @ApiOperation({ summary: 'Verify retirement certificate authenticity' })
  @ApiResponse({ status: 200, description: 'Certificate verification result' })
  @ApiResponse({ status: 404, description: 'Certificate not found' })
  @Get('certificates/:id/verify')
  verifyCertificate(
    @Param('id') certificateId: string,
  ): Promise<CertificateVerification> {
    return this.retirementService.verifyCertificate(certificateId);
  }
}
