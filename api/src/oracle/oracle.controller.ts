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
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import {
  OracleService,
  MrvWebhookDto,
  MrvHistoryResponse,
  MrvAggregateResponse,
  OracleStatusResponse,
} from './oracle.service';
import { AdminGuard } from '../admin/admin.guard';
import { WebhookIpAllowlistGuard } from '../webhooks/webhook-ip-allowlist.guard';
import { Observable } from 'rxjs';

@ApiTags('oracle')
@Controller('oracle')
export class OracleController {
  constructor(private readonly oracleService: OracleService) {}

  // ── Issue #1318: SSE live MRV stream per project ─────────────────────────────

  /**
   * GET /oracle/projects/:id/stream
   *
   * Server-Sent Events endpoint that streams live MRV readings for a project.
   *
   * - Emits a `MessageEvent` with `data: MrvDataPoint` each time a new MRV
   *   reading is ingested for the project via `POST /oracle/mrv`.
   * - Emits a keep-alive ping every 15 seconds (`type: 'ping'`, `data: ':ping'`)
   *   so proxies and browsers do not close idle connections.
   *
   * Clients using the browser `EventSource` API reconnect automatically on
   * disconnect.  No authentication is required (public read endpoint).
   *
   * Issue #1318
   */
  @ApiOperation({
    summary:
      'Stream live MRV readings for a project via Server-Sent Events (Issue #1318)',
  })
  @ApiResponse({
    status: 200,
    description: 'SSE stream — emits MrvDataPoint on each new reading',
  })
  @Sse('projects/:id/stream')
  streamProject(@Param('id') id: string): Observable<MessageEvent> {
    return this.oracleService.streamProject(id);
  }

  // ── Issue #1169: Health/Status endpoint (public) ─────────────────────────────

  /**
   * GET /oracle/status
   *
   * Returns the oracle contract health status:
   * - paused: whether the contract is currently paused
   * - oracleCount: number of registered oracle addresses
   * - globalThresholdBps: global anomaly threshold in basis points
   * - lastUpdatePerProject: latest MRV reading per configured project
   *
   * Response is cached for 30 seconds.
   */
  @ApiOperation({
    summary: 'Get oracle contract health/status (Issue #1169)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Oracle health info — paused, oracle count, threshold, last updates',
    type: Object,
  })
  @ApiResponse({ status: 503, description: 'Oracle contract not initialized' })
  @Get('status')
  getOracleStatus(): Promise<OracleStatusResponse> {
    return this.oracleService.getOracleStatus();
  }

  // ── MRV webhook ingestion ────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Ingest MRV data from an authorised oracle' })
  @ApiBody({
    type: MrvWebhookDto,
    description:
      'Webhook payload with HMAC-SHA256 signature. Signature is computed over `${oraclePublicKey}:${projectId}:${tonnesSequestered}:${timestamp}:${nonce}` using the shared ORACLE_WEBHOOK_SECRET.',
  })
  @ApiResponse({
    status: 201,
    description: 'MRV data ingested, returns anomaly flag',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid payload (bad tonnes, bad timestamp, or bad nonce)',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid oracle signature or stale timestamp',
  })
  @ApiResponse({
    status: 403,
    description: 'IP address not in webhook allowlist',
  })
  @ApiResponse({
    status: 503,
    description: 'Oracle contract not initialized or paused',
  })
  @UseGuards(WebhookIpAllowlistGuard)
  @Post('mrv')
  ingestMrv(@Body() dto: MrvWebhookDto): Promise<{ anomaly: boolean }> {
    return this.oracleService.ingestMrvData(dto);
  }

  // ── MRV history (paginated) ──────────────────────────────────────────────────

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
  @ApiOperation({
    summary: 'Get paginated MRV history for a project (Issue #475)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-based, default 1)',
    example: 1,
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    description: 'Items per page (default 20)',
    example: 20,
  })
  @ApiResponse({ status: 200, description: 'Paginated MRV history' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @Get(':projectId/history')
  getHistory(
    @Param('projectId') projectId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe)
    pageSize: number,
  ): Promise<MrvHistoryResponse> {
    return this.oracleService.getHistory(projectId, page, pageSize);
  }

  // ── MRV aggregate ───────────────────────────────────────────────────────────

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
  @ApiOperation({
    summary:
      'Get aggregated MRV sequestration metrics for a project (Issue #476)',
  })
  @ApiQuery({
    name: 'excludeAnomalies',
    required: false,
    type: String,
    description:
      'Set to "true" to exclude anomalous readings from totalTonnes (default false)',
    example: 'true',
  })
  @ApiResponse({
    status: 200,
    description: 'Aggregated MRV metrics with monthly breakdown',
  })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @Get(':projectId/aggregate')
  getAggregate(
    @Param('projectId') projectId: string,
    @Query('excludeAnomalies') excludeAnomaliesParam?: string,
  ): Promise<MrvAggregateResponse> {
    const excludeAnomalies = excludeAnomaliesParam?.toLowerCase() === 'true';
    return this.oracleService.getAggregate(projectId, excludeAnomalies);
  }

  // ── Anomaly threshold override (admin) ──────────────────────────────────────

  @ApiOperation({
    summary:
      'Set per-project anomaly threshold override (admin only). Pass thresholdBps=0 to clear.',
  })
  @ApiBearerAuth()
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        thresholdBps: {
          type: 'number',
          description:
            'Anomaly threshold in basis points (0–10000). Pass 0 to clear the override.',
          example: 1000,
        },
      },
      required: ['thresholdBps'],
    },
  })
  @ApiResponse({ status: 200, description: 'Threshold updated' })
  @ApiResponse({
    status: 400,
    description: 'Invalid thresholdBps (must be integer 0–10000)',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin only' })
  @UseGuards(JwtAuthGuard, AdminGuard)
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
