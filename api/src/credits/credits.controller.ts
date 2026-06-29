import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CreditsService } from './credits.service';
import { IssueCreditDto } from './dto/issue-credit.dto';
import { TransferCreditDto } from './dto/transfer-credit.dto';
import { SplitCreditDto } from './dto/split-credit.dto';
import { CreditMetadata } from '../../../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PageResult } from './credit.repository';

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
  async getBulkCredits(
    @Body() dto: { ids: string[] },
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
  @ApiResponse({ status: 404, description: 'Credit not found' })
  @Get(':id')
  async getCredit(@Param('id') id: string): Promise<CreditMetadata> {
    return this.creditsService.getCredit(id);
  }

  /** GET /credits/:id/provenance — retrieve full lifecycle of a credit (protected: requires JWT) */
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Get credit provenance',
    description: 'Returns the full lifecycle of a credit including all events (submit, approval, transfers, retirement)',
  })
  @Get(':id/provenance')
  async getCreditProvenance(
    @Param('id') creditId: string,
  ): Promise<Array<{
    action: string;
    actor: string;
    timestamp: number;
    txHash: string;
  }>> {
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
    return this.creditsService.transferCredit(creditId, dto.to, req.user.account, dto.nonce);
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
    return this.creditsService.splitCredit(creditId, dto.splitTonnes, req.user.account, dto.nonce);
  }
}
