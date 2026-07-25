import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  DefaultValuePipe,
  ParseIntPipe,
  Request,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CreditsService } from './credits.service';
import { ETagCacheInterceptor } from './etag-cache.interceptor';
import { IssueCreditDto } from './dto/issue-credit.dto';
import { TransferCreditDto } from './dto/transfer-credit.dto';
import { SplitCreditDto } from './dto/split-credit.dto';
import { ExpireCreditDto } from './dto/expire-credit.dto';
import { DisputeCreditDto } from './dto/dispute-credit.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { MergeCreditsDto } from './dto/merge-credits.dto';
import { CreditMetadata, CreditStatus } from '../../../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PageResult } from './credit.repository';
import { BulkCreditsDto } from './dto/bulk-credits.dto';

@ApiTags('credits')
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @ApiOperation({ summary: 'Issue a new carbon credit' })
  @ApiResponse({ status: 201, description: 'Credit issued successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post('issue')
  issueCredit(@Body() dto: IssueCreditDto): Promise<{ creditId: string }> {
    return this.creditsService.issueCredit(dto);
  }

  @ApiOperation({ summary: 'Bulk fetch credits by IDs' })
  @ApiResponse({ status: 200, description: 'Returns credit metadata array' })
  @Post('bulk')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false }))
  async getBulkCredits(
    @Body() dto: BulkCreditsDto,
  ): Promise<CreditMetadata[]> {
    return this.creditsService.getBulkCredits(dto.ids);
  }

  @ApiOperation({ summary: 'List credits with optional filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of credits' })
  @Get()
  async listCredits(
    @Query('methodology') methodology?: string,
    @Query('geography') geography?: string,
    @Query('vintage_year') vintageYear?: string,
    @Query('status') status?: string,
    @Query('min_tonnes') minTonnes?: string,
    @Query('max_tonnes') maxTonnes?: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ): Promise<{
    data: CreditMetadata[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.creditsService.listCredits({
      methodology,
      geography,
      vintageYear: vintageYear ? parseInt(vintageYear, 10) : undefined,
      status,
      minTonnes,
      maxTonnes,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
  }

  @ApiOperation({ summary: 'Get credit by ID' })
  @ApiResponse({ status: 200, description: 'Credit metadata' })
  @ApiResponse({ status: 304, description: 'Not Modified (ETag match)' })
  @ApiResponse({ status: 404, description: 'Credit not found' })
  @UseInterceptors(ETagCacheInterceptor)
  @Get(':id')
  async getCredit(@Param('id') id: string): Promise<CreditMetadata> {
    return this.creditsService.getCredit(id);
  }

  /** GET /credits/:id/provenance — retrieve full lifecycle of a credit (protected: requires JWT) */
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Get credit provenance',
    description:
      'Returns the full lifecycle of a credit including all events (submit, approval, transfers, retirement)',
  })
  @Get(':id/provenance')
  async getCreditProvenance(@Param('id') creditId: string): Promise<
    Array<{
      action: string;
      actor: string;
      timestamp: number;
      txHash: string;
    }>
  > {
    return this.creditsService.getCreditProvenance(creditId);
  }

  @ApiOperation({ summary: 'List credits by project' })
  @Get('project/:projectId')
  async listByProject(
    @Param('projectId') projectId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) _page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) _limit: number,
  ): Promise<string[]> {
    return this.creditsService.listCreditsByProject(projectId);
  }

  @ApiOperation({ summary: 'Transfer a credit to another address' })
  @ApiResponse({ status: 200, description: 'Credit transferred successfully' })
  @ApiResponse({ status: 400, description: 'Caller does not own this credit' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/transfer')
  async transferCredit(
    @Param('id') creditId: string,
    @Body() dto: TransferCreditDto,
    @Request() req: any,
  ): Promise<CreditMetadata> {
    return this.creditsService.transferCredit(
      creditId,
      dto.to,
      req.user.account,
      dto.nonce,
    );
  }

  @ApiOperation({ summary: 'Split a credit into two child credits' })
  @ApiResponse({ status: 201, description: 'Credit split successfully' })
  @ApiResponse({ status: 400, description: 'Caller does not own this credit' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/split')
  async splitCredit(
    @Param('id') creditId: string,
    @Body() dto: SplitCreditDto,
    @Request() req: any,
  ): Promise<{ childCredit1: string; childCredit2: string }> {
    return this.creditsService.splitCredit(
      creditId,
      dto.splitTonnes,
      req.user.account,
      dto.nonce,
    );
  }

  // ── Issue #485: Credit expiry ─────────────────────────────────────────────

  /**
   * POST /api/v1/credits/:id/expire
   *
   * Transition an Active credit to Expired on-chain.
   * Only callable by the admin (JWT required).
   *
   * The contract verifies the credit is Active (or Disputed) and that the
   * caller is the registered admin.  Expired credits can no longer be traded
   * or retired.
   */
  @ApiOperation({
    summary: 'Expire a carbon credit',
    description:
      'Transitions an Active credit to Expired on-chain. Admin only.',
  })
  @ApiResponse({
    status: 201,
    description: 'Credit expired successfully',
    schema: {
      example: { creditId: 'a1b2c3...', status: 'Expired' },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Credit not found' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/expire')
  async expireCredit(
    @Param('id') creditId: string,
    @Body() dto: ExpireCreditDto,
  ): Promise<{ creditId: string; status: CreditStatus }> {
    return this.creditsService.expireCredit(creditId, dto.adminPublicKey);
  }

  // ── Issue #486: Dispute lifecycle ─────────────────────────────────────────

  /**
   * POST /api/v1/credits/:id/dispute
   *
   * Raise a dispute against an Active credit.
   * Any registered verifier or the credit owner may call this (JWT required).
   *
   * The credit transitions to Disputed, blocking trades on the marketplace.
   * Evidence (IPFS hash) is stored on-chain in DataKey::Dispute(credit_id).
   */
  @ApiOperation({
    summary: 'Raise a dispute against a credit',
    description:
      'Transitions an Active credit to Disputed and stores evidence on-chain.',
  })
  @ApiResponse({
    status: 201,
    description: 'Credit disputed successfully',
    schema: {
      example: { creditId: 'a1b2c3...', status: 'Disputed' },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Credit not found' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/dispute')
  async disputeCredit(
    @Param('id') creditId: string,
    @Body() dto: DisputeCreditDto,
  ): Promise<{ creditId: string; status: CreditStatus }> {
    return this.creditsService.disputeCredit(
      creditId,
      dto.disputerPublicKey,
      dto.evidenceIpfsHash,
    );
  }

  /**
   * POST /api/v1/credits/:id/resolve
   *
   * Resolve a disputed credit.  Admin only (JWT required).
   *
   * Outcome codes:
   *   0 → Active   (dispute dismissed, credit reinstated)
   *   1 → Flagged  (dispute escalated for further review)
   *   2 → Retired  (credit revoked — treated as consumed)
   */
  @ApiOperation({
    summary: 'Resolve a disputed credit',
    description:
      'Admin-only. Resolves a Disputed credit: 0=Active, 1=Flagged, 2=Retired.',
  })
  @ApiResponse({
    status: 201,
    description: 'Dispute resolved successfully',
    schema: {
      example: { creditId: 'a1b2c3...', status: 'Active', outcome: 0 },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Credit not found' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/resolve')
  async resolveDispute(
    @Param('id') creditId: string,
    @Body() dto: ResolveDisputeDto,
  ): Promise<{ creditId: string; status: CreditStatus; outcome: number }> {
    return this.creditsService.resolveDispute(
      creditId,
      dto.adminPublicKey,
      dto.outcome,
    );
  }

  // ── Issue #487: Credit merging ────────────────────────────────────────────

  /**
   * POST /api/v1/credits/merge
   *
   * Merge 2–20 Active credits owned by the same caller into a single new
   * credit.  Input credits are consumed (Retired); the new credit is Active
   * with tonnes = sum of inputs.
   *
   * All input credits must share the same project_id, vintage_year,
   * methodology, and geography.  JWT required.
   *
   * Note: The route is declared BEFORE `:id` sub-routes so NestJS does not
   * accidentally route /merge to a param handler.
   */
  @ApiOperation({
    summary: 'Merge multiple credits into one',
    description:
      'Merges 2–20 Active credits owned by the caller. All inputs must share project/vintage/methodology/geography.',
  })
  @ApiResponse({
    status: 201,
    description: 'Credits merged successfully',
    schema: {
      example: { mergedCreditId: 'deadbeef...', sourceCount: 3 },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid merge request' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post('merge')
  async mergeCredits(
    @Body() dto: MergeCreditsDto,
  ): Promise<{ mergedCreditId: string; sourceCount: number }> {
    return this.creditsService.mergeCredits(dto.callerPublicKey, dto.creditIds);
  }
}
