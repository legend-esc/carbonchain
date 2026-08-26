import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import {
  OracleService,
  MrvWebhookDto,
  MrvHistoryResponse,
  MrvAggregateResponse,
} from './oracle.service';
import { AdminGuard } from '../admin/admin.guard';

@ApiTags('oracle')
@Controller('oracle')
export class OracleController {
  constructor(private readonly oracleService: OracleService) {}

  @ApiOperation({ summary: 'Ingest MRV data from an authorised oracle' })
  @ApiResponse({
    status: 201,
    description: 'MRV data ingested, returns anomaly flag',
  })
  @ApiResponse({ status: 401, description: 'Invalid oracle signature' })
  @Post('mrv')
  ingestMrv(@Body() dto: MrvWebhookDto): Promise<{ anomaly: boolean }> {
    return this.oracleService.ingestMrvData(dto);
  }

  /**
   * GET /oracle/:projectId/history?page=1&pageSize=20
   *
   * Returns a paginated list of MrvDataPoint objects for the given project.
   * The full history is fetched from the contract in one call and paginated
   * server-side (Soroban does not support server-side vec pagination).
   *
   * Response shape matches `shared/index.ts` MrvDataPoint.
   * Empty history returns { data: [], total: 0 } with HTTP 200.
   *
   * Issue #475
   */
  @Get(':projectId/history')
  getHistory(
    @Param('projectId') projectId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe)
    pageSize: number,
  ): Promise<MrvHistoryResponse> {
    return this.oracleService.getHistory(projectId, page, pageSize);
  }

  /**
   * GET /oracle/:projectId/aggregate?excludeAnomalies=true
   *
   * Computes rolling sequestration totals from the full MRV history.
   * Returns: { totalTonnes, readingCount, anomalyCount, latestReading, monthlyBreakdown }
   *
   * All tonne values are strings (BigInt-safe).
   * `excludeAnomalies=true` removes anomalous readings from totalTonnes.
   *
   * Issue #476
   */
  @Get(':projectId/aggregate')
  getAggregate(
    @Param('projectId') projectId: string,
    @Query('excludeAnomalies') excludeAnomaliesParam?: string,
  ): Promise<MrvAggregateResponse> {
    const excludeAnomalies = excludeAnomaliesParam?.toLowerCase() === 'true';
    return this.oracleService.getAggregate(projectId, excludeAnomalies);
  }

  @ApiOperation({
    summary:
      'Set per-project anomaly threshold override (admin only). Pass thresholdBps=0 to clear.',
  })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Threshold updated' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin only' })
  @UseGuards(AuthGuard('jwt'), AdminGuard)
  @Patch(':projectId/threshold')
  @HttpCode(HttpStatus.OK)
  async setProjectThreshold(
    @Param('projectId') projectId: string,
    @Body() body: { thresholdBps: number },
  ): Promise<{ projectId: string; thresholdBps: number | null }> {
    return this.oracleService.setProjectAnomalyThreshold(
      projectId,
      body.thresholdBps,
    );
  }
}
