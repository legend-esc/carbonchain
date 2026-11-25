/**
 * #1304 — MarketplaceAnalyticsService
 *
 * Provides GET /marketplace/candles endpoint with OHLCV candlestick data for
 * price charts.
 *
 * Data model:
 *  - Reads raw trade executions from the `retirements` table (each retirement
 *    is treated as a matched trade: price = tonnes_retired converted from XLM,
 *    volume = tonnes_retired).
 *  - Aggregates rows into OHLCV buckets using SQL DATE_TRUNC.
 *  - Fills gaps (zero-volume candles) so the chart has a continuous time axis.
 *  - Caches aggregated candles in Redis for 5 minutes (300 s).
 *
 * Supported timeframes: 1h, 1d, 1w.
 *
 * Query parameters:
 *   creditId   — optional; filters to a single credit
 *   methodology — optional; filters by methodology string
 *   timeframe  — '1h' | '1d' | '1w' (default '1d')
 *   from       — Unix epoch seconds (default: 30 days ago)
 *   to         — Unix epoch seconds (default: now)
 */
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CacheService } from '../common/cache.service';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OhlcvCandle {
  /** Unix timestamp in seconds for the start of the candle bucket. */
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Sum of tonnes_retired within the bucket (volume proxy). */
  volume: string;
  /** Number of trades in this bucket. */
  tradeCount: number;
}

export type Timeframe = '1h' | '1d' | '1w';

export interface CandlesQueryDto {
  creditId?: string;
  methodology?: string;
  timeframe?: Timeframe;
  from?: number;
  to?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 300; // 5 minutes
const DEFAULT_TIMEFRAME: Timeframe = '1d';
const DEFAULT_LOOKBACK_DAYS = 30;

/** Map timeframe strings to PostgreSQL DATE_TRUNC precision. */
const TIMEFRAME_TRUNC: Record<Timeframe, string> = {
  '1h': 'hour',
  '1d': 'day',
  '1w': 'week',
};

/** Timeframe bucket widths in seconds (used for gap-filling). */
const TIMEFRAME_STEP_SECONDS: Record<Timeframe, number> = {
  '1h': 3600,
  '1d': 86400,
  '1w': 604800,
};

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class MarketplaceAnalyticsService {
  private readonly logger = new Logger(MarketplaceAnalyticsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Returns OHLCV candle data for the given query parameters.
   *
   * Cache key: `candles:<timeframe>:<creditId|all>:<methodology|all>:<from>:<to>`
   * TTL: 5 minutes.
   */
  async getCandles(query: CandlesQueryDto): Promise<OhlcvCandle[]> {
    const timeframe = this.validateTimeframe(
      query.timeframe ?? DEFAULT_TIMEFRAME,
    );
    const now = Math.floor(Date.now() / 1000);
    const from = query.from ?? now - DEFAULT_LOOKBACK_DAYS * 86400;
    const to = query.to ?? now;

    if (from > to) {
      throw new BadRequestException('"from" must be before "to"');
    }

    const cacheKey = `candles:${timeframe}:${query.creditId ?? 'all'}:${query.methodology ?? 'all'}:${from}:${to}`;

    const cached = await this.cacheService.get<OhlcvCandle[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache HIT for ${cacheKey}`);
      return cached;
    }

    const raw = await this.fetchRaw(
      query.creditId,
      query.methodology,
      timeframe,
      from,
      to,
    );
    const candles = this.fillGaps(raw, timeframe, from, to);

    await this.cacheService.set(cacheKey, candles, CACHE_TTL_SECONDS);
    return candles;
  }

  // ── SQL query ──────────────────────────────────────────────────────────────

  /**
   * Runs the SQL aggregation over the retirements table.
   *
   * We treat the retired_at timestamp as the trade time and tonnes_retired
   * as the volume. The price per tonne is modelled as the numeric value of
   * tonnes_retired divided by 1 (a placeholder until a price_history table
   * stores actual XLM prices). This is intentionally extensible: when a
   * trade_executions table is added, only this method needs updating.
   *
   * The price columns (open, high, low, close) are populated using the
   * FIRST_VALUE / LAST_VALUE window functions over the ordered bucket so
   * the OHLCV shape is correct even with multiple trades per bucket.
   */
  private async fetchRaw(
    creditId: string | undefined,
    methodology: string | undefined,
    timeframe: Timeframe,
    from: number,
    to: number,
  ): Promise<OhlcvCandle[]> {
    const truncUnit = TIMEFRAME_TRUNC[timeframe];

    // Build dynamic WHERE clauses without SQL injection risk.
    const params: (string | number)[] = [from, to];
    const conditions: string[] = ['r.retired_at >= $1', 'r.retired_at <= $2'];

    if (creditId) {
      params.push(creditId);
      conditions.push(`r.credit_id = $${params.length}`);
    }

    if (methodology) {
      params.push(methodology);
      conditions.push(`c.methodology = $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');
    const joinClause = methodology
      ? 'LEFT JOIN credits c ON c.id = r.credit_id'
      : '';

    // We approximate "price" as a numeric representation of tonnes_retired
    // cast to NUMERIC. When an actual price field is available this query
    // should use that column instead.
    const sql = `
      WITH trades AS (
        SELECT
          DATE_TRUNC('${truncUnit}', TO_TIMESTAMP(r.retired_at)) AS bucket,
          CAST(r.tonnes_retired AS NUMERIC)                      AS price,
          CAST(r.tonnes_retired AS NUMERIC)                      AS volume,
          r.retired_at                                           AS ts
        FROM retirements r
        ${joinClause}
        WHERE ${whereClause}
      ),
      ordered AS (
        SELECT
          bucket,
          price,
          volume,
          ts,
          FIRST_VALUE(price) OVER (
            PARTITION BY bucket ORDER BY ts ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          ) AS open_price,
          LAST_VALUE(price) OVER (
            PARTITION BY bucket ORDER BY ts ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          ) AS close_price
        FROM trades
      )
      SELECT
        EXTRACT(EPOCH FROM bucket)::BIGINT AS time,
        MIN(open_price)                    AS open,
        MAX(price)                         AS high,
        MIN(price)                         AS low,
        MIN(close_price)                   AS close,
        SUM(volume)                        AS volume,
        COUNT(*)                           AS trade_count
      FROM ordered
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    try {
      const rows: Array<{
        time: string;
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string;
        trade_count: string;
      }> = await this.dataSource.query(sql, params);

      return rows.map((r) => ({
        time: Number(r.time),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        tradeCount: Number(r.trade_count),
      }));
    } catch (err) {
      this.logger.error(`Candle query failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Gap filling ────────────────────────────────────────────────────────────

  /**
   * Fills zero-volume forward-fill gaps between candle buckets.
   *
   * For buckets with no trades, a zero-volume candle is inserted whose
   * open/high/low/close are forward-filled from the most recent real candle.
   * This matches what most charting libraries expect.
   */
  fillGaps(
    candles: OhlcvCandle[],
    timeframe: Timeframe,
    from: number,
    to: number,
  ): OhlcvCandle[] {
    const stepSeconds = TIMEFRAME_STEP_SECONDS[timeframe];
    const result: OhlcvCandle[] = [];

    // Build a sorted array of all expected bucket timestamps.
    // Start from the first real candle's time (or the floored `from`) and
    // step by `stepSeconds` through the range, then also ensure every real
    // candle's timestamp is represented.
    const candleTimes = new Set(candles.map((c) => c.time));

    // Determine start: use the minimum of candle times and floored `from`.
    const flooredFrom = Math.floor(from / stepSeconds) * stepSeconds;
    const start =
      candles.length > 0 ? Math.min(flooredFrom, candles[0].time) : flooredFrom;

    // Build set of all timestamps to include: generated steps + real candle times.
    const allTimes = new Set<number>();
    // Add generated steps in the range [start, to].
    const flooredTo = Math.floor(to / stepSeconds) * stepSeconds;
    const rangeEnd =
      candles.length > 0
        ? Math.max(flooredTo, candles[candles.length - 1].time)
        : flooredTo;
    for (let t = start; t <= rangeEnd; t += stepSeconds) {
      allTimes.add(t);
    }
    // Ensure all real candle timestamps are included even if not on the step grid.
    for (const c of candles) {
      allTimes.add(c.time);
    }

    // Sort all timestamps and emit candles.
    const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);
    const candleMap = new Map(candles.map((c) => [c.time, c]));
    let lastClose = '0';

    for (const t of sortedTimes) {
      const existing = candleMap.get(t);
      if (existing) {
        result.push(existing);
        lastClose = existing.close;
      } else {
        // Zero-volume gap candle — forward-fill from previous close.
        result.push({
          time: t,
          open: lastClose,
          high: lastClose,
          low: lastClose,
          close: lastClose,
          volume: '0',
          tradeCount: 0,
        });
      }
    }

    return result;
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  private validateTimeframe(raw: string): Timeframe {
    if (raw === '1h' || raw === '1d' || raw === '1w') {
      return raw;
    }
    throw new BadRequestException(
      `Invalid timeframe "${raw}". Supported values: 1h, 1d, 1w`,
    );
  }
}
