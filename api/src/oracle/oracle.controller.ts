import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import {
  OracleService,
  MrvWebhookDto,
  MrvHistoryResponse,
  MrvAggregateResponse,
} from './oracle.service';

@Controller('oracle')
export class OracleController {
  constructor(private readonly oracleService: OracleService) {}

  /** POST /oracle/mrv — ingest MRV data from an authorised oracle */
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
    const excludeAnomalies =
      excludeAnomaliesParam?.toLowerCase() === 'true';
    return this.oracleService.getAggregate(projectId, excludeAnomalies);
  }
}
