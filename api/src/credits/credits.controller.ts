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
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CreditsService, IssueCreditDto } from './credits.service';
import { CreditMetadata } from '../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PageResult } from './credit.repository';
import { RetirementService } from '../retirement/retirement.service';
import { RetireDto } from '../retirement/dto/retire.dto';

@ApiTags('credits')
@Controller('credits')
export class CreditsController {
  constructor(
    private readonly creditsService: CreditsService,
    private readonly retirementService: RetirementService,
  ) {}

  /** POST /credits/issue — protected: requires JWT */
  @UseGuards(JwtAuthGuard)
  @Post('issue')
  issueCredit(@Body() dto: IssueCreditDto): Promise<{ creditId: string }> {
    return this.creditsService.issueCredit(dto);
  }

  @Post('bulk')
  async getBulkCredits(
    @Body() dto: { ids: string[] },
  ): Promise<CreditMetadata[]> {
    return this.creditsService.getBulkCredits(dto.ids);
  }

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
  @UseGuards(JwtAuthGuard)
  @Post(':id/transfer')
  async transferCredit(
    @Param('id') creditId: string,
    @Body() dto: { to: string },
    @Request() req: any,
  ): Promise<CreditMetadata> {
    return this.creditsService.transferCredit(creditId, dto.to, req.user.account);
  }

  @ApiOperation({ summary: 'Split a credit into two child credits' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/split')
  async splitCredit(
    @Param('id') creditId: string,
    @Body() dto: { splitTonnes: number },
    @Request() req: any,
  ): Promise<{ childCredit1: string; childCredit2: string }> {
    return this.creditsService.splitCredit(creditId, dto.splitTonnes, req.user.account);
  }

  /**
   * ## Thin proxy — retire via credit ID route
   *
   * `POST /credits/:id/retire` is a convenience route that delegates directly
   * to the **canonical** `POST /retirement` entrypoint via
   * `RetirementService.retire()`.  Both routes share the same DTO shape
   * (`RetireDto`) and return an identical response:
   * `{ retirementId: string; certificateIpfsHash: string }`.
   *
   * Do NOT add independent logic here — all retire business logic lives in
   * `RetirementService.retire()`.
   */
  @ApiOperation({
    summary: '(Proxy) Retire a credit — delegates to POST /retirement',
    description:
      'Thin proxy for POST /retirement. Uses the same RetireDto and returns the same response shape. The credit ID from the URL is used as the creditId field.',
  })
  @UseGuards(JwtAuthGuard)
  @Post(':id/retire')
  async retireCredit(
    @Param('id') creditId: string,
    @Body() body: { buyerPublicKey: string; tonnes: string; reason: string },
    @Request() req: any,
  ): Promise<{ retirementId: string; certificateIpfsHash: string }> {
    const dto: RetireDto = {
      buyerPublicKey: body.buyerPublicKey ?? req.user.account,
      creditId,
      tonnes: body.tonnes,
      reason: body.reason,
    };
    return this.retirementService.retire(dto);
  }
}
