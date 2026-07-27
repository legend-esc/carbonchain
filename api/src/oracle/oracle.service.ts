import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { CacheService } from '../common/cache.service';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { MrvDataPoint } from '../../shared';

// ── DTOs ─────────────────────────────────────────────────────────────────────

export class MrvWebhookDto {
  oraclePublicKey: string;
  projectId: string;
  tonnesSequestered: string;
  signature: string; // HMAC-SHA256 hex of `${projectId}:${tonnesSequestered}` with ORACLE_WEBHOOK_SECRET
}

// ── Response types ────────────────────────────────────────────────────────────

export interface MrvHistoryResponse {
  data: MrvDataPoint[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MonthlyBucket {
  /** ISO year-month string, e.g. "2024-03" */
  month: string;
  /** Total tonnes sequestered in this month (as string for BigInt safety) */
  totalTonnes: string;
  readingCount: number;
  anomalyCount: number;
}

export interface MrvAggregateResponse {
  /** All-time total tonnes sequestered (as string) */
  totalTonnes: string;
  readingCount: number;
  anomalyCount: number;
  /** Latest MRV data point, or null if no history */
  latestReading: MrvDataPoint | null;
  /** Monthly breakdown sorted by month ascending */
  monthlyBreakdown: MonthlyBucket[];
}

// ── Cache keys ────────────────────────────────────────────────────────────────

const HISTORY_CACHE_TTL = 30; // seconds
const AGGREGATE_CACHE_TTL = 60; // seconds

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class OracleService {
  private readonly logger = new Logger(OracleService.name);
  private readonly contractId: string;
  private readonly webhookSecret: string;

  constructor(
    private readonly stellarService: StellarService,
    private readonly keypairService: StellarKeypairService,
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) {
    this.contractId = this.configService.get<string>(
      'MRV_ORACLE_CONTRACT_ID',
      '',
    );
    this.webhookSecret = this.configService.get<string>(
      'ORACLE_WEBHOOK_SECRET',
      'changeme',
    );
  }

  // ── HMAC validation ──────────────────────────────────────────────────────────

  /**
   * Validate HMAC-SHA256 signature over `${projectId}:${tonnesSequestered}`.
   */
  private validateSignature(dto: MrvWebhookDto): void {
    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${dto.projectId}:${dto.tonnesSequestered}`)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(dto.signature, 'hex');

    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      throw new UnauthorizedException('Invalid oracle signature');
    }
  }

  // ── Issue #474: ingestMrvData — timestamp passed correctly, rejection handled ─

  /**
   * Ingest an MRV data point from an authorised oracle webhook.
   *
   * The current wall-clock time (seconds since epoch) is passed as the
   * `recorded_at` argument. The contract validates that the timestamp is not
   * in the future (> ledger timestamp), so the API does not need to enforce
   * that rule — but it must handle the resulting `InvalidTimestamp` error
   * gracefully instead of surfacing a raw contract panic.
   */
  async ingestMrvData(dto: MrvWebhookDto): Promise<{ anomaly: boolean }> {
    this.validateSignature(dto);

    const tonnes = BigInt(dto.tonnesSequestered);
    if (tonnes <= 0n) {
      throw new BadRequestException(
        'tonnes must be positive (greater than 0)',
      );
    }

    this.logger.log(
      `MRV update for project ${dto.projectId} from oracle ${dto.oraclePublicKey}`,
    );

    // Use current wall-clock time in seconds — the contract will reject values
    // that are more than the allowed tolerance ahead of ledger time.
    const timestampSeconds = BigInt(Math.floor(Date.now() / 1000));

    const args = [
      nativeToScVal(dto.oraclePublicKey, { type: 'address' }),
      nativeToScVal(dto.projectId, { type: 'string' }),
      nativeToScVal(BigInt(dto.tonnesSequestered), { type: 'i128' }),
      nativeToScVal(timestampSeconds, { type: 'u64' }),
    ];

    const signer = this.keypairService.getAdminKeypair();

    let response: unknown;
    try {
      response = await this.stellarService.invokeContract(
        this.contractId,
        'update_mrv_data',
        args,
        signer,
      );
    } catch (err: unknown) {
      // Surface contract-level timestamp rejection as a 400 to the caller
      // rather than an opaque 500. The contract returns OracleError::InvalidTimestamp (127)
      // when the supplied timestamp is in the future relative to the ledger.
      const message =
        err instanceof Error ? err.message : String(err);
      if (
        message.includes('InvalidTimestamp') ||
        message.includes('127')
      ) {
        throw new BadRequestException(
          'Timestamp rejected by contract: clock skew too large. Please retry.',
        );
      }
      this.logger.error(`Contract invocation failed: ${message}`);
      throw new InternalServerErrorException(
        'Failed to submit MRV data to contract',
      );
    }

    const rv = (response as Record<string, unknown>)?.returnValue;
    const anomaly = rv
      ? Boolean(scValToNative(rv as Parameters<typeof scValToNative>[0]))
      : false;

    // Bust cached history / aggregate for this project on successful ingestion
    await this.cacheService.del(`oracle:history:${dto.projectId}`);
    await this.cacheService.del(`oracle:aggregate:${dto.projectId}`);
    await this.cacheService.del(`oracle:aggregate:${dto.projectId}:noAnomaly`);

    return { anomaly };
  }

  // ── Issue #475: getHistory — paginated MRV history ───────────────────────────

  /**
   * Fetch the full MRV history for `projectId` from the contract's
   * `DataKey::History(project_id)` persistent storage and paginate it
   * server-side (the contract returns the entire Vec in one call).
   *
   * Response shape matches `shared/index.ts` `MrvDataPoint`.
   *
   * Cache TTL: 30 s. Cache is busted when new MRV data arrives via
   * `ingestMrvData`.
   */
  async getHistory(
    projectId: string,
    page: number,
    pageSize: number,
  ): Promise<MrvHistoryResponse> {
    const cacheKey = `oracle:history:${projectId}`;

    // Try cache first (full raw list before pagination)
    let raw: MrvDataPoint[] | null =
      await this.cacheService.get<MrvDataPoint[]>(cacheKey);

    if (!raw) {
      const args = [nativeToScVal(projectId, { type: 'string' })];

      let contractResponse: unknown;
      try {
        contractResponse = await this.stellarService.readContract(
          this.contractId,
          'get_history',
          args,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `get_history contract call failed for ${projectId}: ${message}`,
        );
        // Return empty result rather than 500 when project has no history yet
        return { data: [], total: 0, page, pageSize };
      }

      raw = this.deserializeHistory(contractResponse);
      await this.cacheService.set(cacheKey, raw, HISTORY_CACHE_TTL);
    }

    // Server-side pagination
    const total = raw.length;
    const offset = (page - 1) * pageSize;
    const data = raw.slice(offset, offset + pageSize);

    return { data, total, page, pageSize };
  }

  /**
   * Deserialise the raw contract response (a Soroban Vec of MrvDataPoint)
   * into the `MrvDataPoint` shape defined in `shared/index.ts`.
   *
   * Contract shape:  { oracle: Address, project_id: String, tonnes: i128, recorded_at: u64, anomaly: bool }
   * Shared shape:    { oracle: string, project_id: string, tonnes_sequestered: string, measurement_date: number, methodology: string, anomaly_flag: boolean }
   */
  private deserializeHistory(raw: unknown): MrvDataPoint[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return (raw as Array<Record<string, unknown>>).map((item) => ({
      oracle: String(item['oracle'] ?? ''),
      project_id: String(item['project_id'] ?? ''),
      // tonnes is i128 — convert via BigInt to avoid precision loss
      tonnes_sequestered: BigInt(
        String(item['tonnes'] ?? '0'),
      ).toString(),
      measurement_date: Number(item['recorded_at'] ?? 0),
      // methodology is not stored on-chain in the data point; default to empty
      methodology: String(item['methodology'] ?? ''),
      anomaly_flag: Boolean(item['anomaly'] ?? false),
    }));
  }

  // ── Issue #476: getAggregate — rolling totals with BigInt arithmetic ──────────

  /**
   * Compute aggregated sequestration figures from the full MRV history.
   *
   * All tonne arithmetic is done with BigInt to prevent float precision loss.
   * Monthly buckets group readings by UTC calendar month of `recorded_at`
   * (Stellar ledger timestamp in seconds since Unix epoch).
   *
   * `excludeAnomalies=true` removes anomalous readings from `totalTonnes` and
   * `monthlyBreakdown.totalTonnes` but still counts them in `anomalyCount`.
   *
   * Cache TTL: 60 s. Cache is busted when new MRV data arrives.
   */
  async getAggregate(
    projectId: string,
    excludeAnomalies = false,
  ): Promise<MrvAggregateResponse> {
    const cacheKey = excludeAnomalies
      ? `oracle:aggregate:${projectId}:noAnomaly`
      : `oracle:aggregate:${projectId}`;

    const cached = await this.cacheService.get<MrvAggregateResponse>(cacheKey);
    if (cached) return cached;

    // Reuse the full (unpaginated) history
    const historyCacheKey = `oracle:history:${projectId}`;
    let raw: MrvDataPoint[] | null =
      await this.cacheService.get<MrvDataPoint[]>(historyCacheKey);

    if (!raw) {
      const args = [nativeToScVal(projectId, { type: 'string' })];

      let contractResponse: unknown;
      try {
        contractResponse = await this.stellarService.readContract(
          this.contractId,
          'get_history',
          args,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `get_history contract call failed for aggregate (${projectId}): ${message}`,
        );
        contractResponse = [];
      }

      raw = this.deserializeHistory(contractResponse);
      await this.cacheService.set(historyCacheKey, raw, HISTORY_CACHE_TTL);
    }

    const result = this.computeAggregate(raw, excludeAnomalies);
    await this.cacheService.set(cacheKey, result, AGGREGATE_CACHE_TTL);
    return result;
  }

  /**
   * Pure computation of aggregate metrics from a list of `MrvDataPoint`s.
   * All arithmetic is BigInt to avoid JS float precision loss.
   */
  computeAggregate(
    points: MrvDataPoint[],
    excludeAnomalies: boolean,
  ): MrvAggregateResponse {
    let totalTonnes = 0n;
    let anomalyCount = 0;
    const monthlyMap = new Map<
      string,
      { totalTonnes: bigint; readingCount: number; anomalyCount: number }
    >();

    let latestReading: MrvDataPoint | null = null;
    let latestTs = -1;

    for (const point of points) {
      if (point.anomaly_flag) {
        anomalyCount++;
      }

      if (!excludeAnomalies || !point.anomaly_flag) {
        const tonnes = BigInt(point.tonnes_sequestered);
        totalTonnes += tonnes;

        // Monthly bucketing — recorded_at is seconds since epoch
        const monthKey = this.toMonthKey(point.measurement_date);
        const bucket = monthlyMap.get(monthKey) ?? {
          totalTonnes: 0n,
          readingCount: 0,
          anomalyCount: 0,
        };
        bucket.totalTonnes += tonnes;
        bucket.readingCount++;
        if (point.anomaly_flag) bucket.anomalyCount++;
        monthlyMap.set(monthKey, bucket);
      }

      if (point.measurement_date > latestTs) {
        latestTs = point.measurement_date;
        latestReading = point;
      }
    }

    // Sort monthly breakdown chronologically
    const monthlyBreakdown: MonthlyBucket[] = Array.from(
      monthlyMap.entries(),
    )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({
        month,
        totalTonnes: bucket.totalTonnes.toString(),
        readingCount: bucket.readingCount,
        anomalyCount: bucket.anomalyCount,
      }));

    return {
      totalTonnes: totalTonnes.toString(),
      readingCount: excludeAnomalies
        ? points.length - anomalyCount
        : points.length,
      anomalyCount,
      latestReading,
      monthlyBreakdown,
    };
  }

  /**
   * Convert a Unix timestamp (seconds) to a "YYYY-MM" UTC month key.
   */
  private toMonthKey(timestampSeconds: number): string {
    const d = new Date(timestampSeconds * 1000);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
}
