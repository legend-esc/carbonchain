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
import { ApiTags, ApiOperation, ApiResponse, ApiProperty } from '@nestjs/swagger';
import type { Response as ExpressResponse } from 'express';
import {
  RetirementService,
  BatchRetireResult,
  CertificateVerification,
} from './retirement.service';
import { FullRetireDto } from './dto/retire.dto';
import { BatchRetireDto } from './dto/batch-retire.dto';
import { RetirementRecord } from '../../../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ThrottlerGuard, Throttle } from '../common/throttler.guard';
import { PageResult } from '../credits/credit.repository';
import { CertificateService } from './certificate.service';
import { CertHashReconciler } from './cert-hash-reconciler.service';

/**
 * Extended certificate response that includes #921 cert hash status
 * and #918 on-chain finality status.
 */
class CertificateResponse implements CertificateVerification {
  @ApiProperty() id: string;
  @ApiProperty() credit_id: string;
  @ApiProperty() buyer: string;
  @ApiProperty() tonnes_retired: string;
  @ApiProperty() reason: string;
  @ApiProperty() retired_at: number;
  @ApiProperty() tx_hash: string;
  @ApiProperty() verified: boolean;
  @ApiProperty({ required: false }) ledger_sequence?: number;

  /**
   * #918 — On-chain finality status.
   * One of: pending | success | failed | timeout
   */
  @ApiProperty({
    description: 'On-chain finality status of the retirement transaction (#918)',
    enum: ['pending', 'success', 'failed', 'timeout'],
    required: false,
  })
  txStatus?: string;

  /**
   * #921 — Certificate IPFS hash write status.
   * One of: none | pending | onchain | failure
   */
  @ApiProperty({
    description: 'On-chain write status of the certificate IPFS hash (#921)',
    enum: ['none', 'pending', 'onchain', 'failure'],
    required: false,
  })
  certHashStatus?: string;
}

@ApiTags('retirement')
@Controller('retirement')
export class RetirementController {
  constructor(
    private readonly retirementService: RetirementService,
    private readonly certificateService: CertificateService,
    private readonly certHashReconciler: CertHashReconciler,
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

  /**
   * GET /retirement/certificates/:id/verify
   *
   * Returns the retirement certificate verification result, including:
   *   - #918: txStatus — on-chain finality state (pending/success/failed/timeout)
   *   - #921: certHashStatus — whether the IPFS hash is written on-chain
   *             (none/pending/onchain/failure)
   */
  @ApiOperation({ summary: 'Verify retirement certificate authenticity' })
  @ApiResponse({
    status: 200,
    description: 'Certificate verification result with on-chain status fields',
    type: CertificateResponse,
  })
  @ApiResponse({ status: 404, description: 'Certificate not found' })
  @Get('certificates/:id/verify')
  verifyCertificate(
    @Param('id') certificateId: string,
  ): Promise<CertificateVerification> {
    return this.retirementService.verifyCertificate(certificateId);
  }

  /**
   * POST /retirement/certificates/:id/reconcile
   *
   * Manually trigger a cert hash reconciliation for a single retirement.
   * Useful for support workflows when the daily reconciler hasn't run yet.
   * #921
   */
  @ApiOperation({
    summary:
      'Trigger cert hash reconciliation for a specific retirement (#921)',
  })
  @ApiResponse({ status: 200, description: 'Reconciliation result' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post('certificates/:id/reconcile')
  async reconcileCertHash(
    @Param('id') retirementId: string,
  ): Promise<{ triggered: boolean; retirementId: string }> {
    // Run the full reconciler scan — it will pick up this record if pending
    await this.certHashReconciler.reconcile(1);
    return { triggered: true, retirementId };
  }
}
