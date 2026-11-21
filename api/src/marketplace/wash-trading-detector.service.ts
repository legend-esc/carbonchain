/**
 * Issue #1321 — Wash-trading detection cron job.
 *
 * Runs hourly, queries all credits from the database, and flags credits whose
 * ownership history shows circular transfer patterns (A→B→A, A→B→C→A) within
 * a configurable rolling window (default 48 hours).
 *
 * Because the schema has no explicit trade-history table, ownership changes are
 * approximated from the current `CreditEntity.owner` field plus the
 * `RetirementEntity` records that link credits to buyers.  Detected suspicious
 * credit IDs are stored in an in-memory `Set`; callers can query
 * `isSuspicious(creditId)` or `getSuspiciousCreditIds()` to filter them out.
 *
 * `getOhlcvCandles()` is a stub that would query a price-history table in
 * production — it returns an empty array and is wired to
 * `GET /marketplace/candles` so the shape is established.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CreditEntity } from '../credits/credit.entity';
import { RetirementEntity } from '../retirement/retirement.entity';

// ── Public types ───────────────────────────────���──────────────────────────────

/** OHLCV candle data point (stub shape for the /marketplace/candles endpoint). */
export interface CandleData {
  /** Unix timestamp in seconds for the start of the candle. */
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** Parameters accepted by `getOhlcvCandles`. */
export interface OhlcvParams {
  creditId?: string;
  from?: number;
  to?: number;
  interval?: string;
}

/** A synthetic trade record derived from retirement data. */
interface TradeRecord {
  from: string;
  to: string;
  creditId: string;
  /** Unix timestamp in seconds. */
  timestamp: number;
  tradeId: string;
}

// ── Default configuration ─────────────────────────────────────────────────────

/** Default rolling window for wash-trade detection (hours). */
const DEFAULT_WASH_TRADE_WINDOW_HOURS = 48;

@Injectable()
export class WashTradingDetectorService {
  private readonly logger = new Logger(WashTradingDetectorService.name);

  /**
   * Rolling window in milliseconds.  Configurable via
   * `WASH_TRADE_WINDOW_HOURS` environment variable.
   */
  private readonly windowMs: number;

  /**
   * In-memory set of credit IDs flagged as suspicious by the last detection
   * run.  Reset and rebuilt on every cron execution.
   */
  private suspiciousCreditIds = new Set<string>();

  constructor(
    @InjectRepository(CreditEntity)
    private readonly creditRepository: Repository<CreditEntity>,

    @InjectRepository(RetirementEntity)
    private readonly retirementRepository: Repository<RetirementEntity>,
  ) {
    const hours =
      parseInt(process.env['WASH_TRADE_WINDOW_HOURS'] ?? '', 10) ||
      DEFAULT_WASH_TRADE_WINDOW_HOURS;
    this.windowMs = hours * 60 * 60 * 1000;
  }

  // ── Cron job ───────────────────────────────────────────────────────────────

  /**
   * Runs every hour.  Loads all credits and retirement records, reconstructs
   * trade flows per credit, then flags credits exhibiting 2-party (A→B→A) or
   * 3-party (A→B→C→A) circular transfers within the rolling window.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async detectWashTrades(): Promise<void> {
    this.logger.log('[#1321] Starting wash-trade detection scan');

    const cutoff = Date.now() - this.windowMs;
    const newSuspicious = new Set<string>();

    // Load retirement records as the proxy for ownership transfers.
    // Each retirement represents: seller (credit.issuer/previous owner) → buyer.
    let retirements: RetirementEntity[];
    try {
      retirements = await this.retirementRepository.find();
    } catch (err) {
      this.logger.error(
        `[#1321] Failed to load retirements: ${(err as Error).message}`,
      );
      return;
    }

    // Build per-credit trade chains from retirement records.
    // retirement.retiredAt is a bigint column stored as number; treat as seconds.
    const tradesByCredit = new Map<string, TradeRecord[]>();

    for (const r of retirements) {
      const timestampMs =
        Number(r.retiredAt) > 1e12
          ? Number(r.retiredAt) // already in ms
          : Number(r.retiredAt) * 1000; // seconds → ms

      if (timestampMs < cutoff) {
        // Outside the detection window — skip.
        continue;
      }

      const existing = tradesByCredit.get(r.creditId) ?? [];
      existing.push({
        from: '', // seller address not stored directly in RetirementEntity
        to: r.buyer,
        creditId: r.creditId,
        timestamp: timestampMs,
        tradeId: r.id,
      });
      tradesByCredit.set(r.creditId, existing);
    }

    // Load credits to resolve current owner for 2-party loop detection.
    let credits: CreditEntity[];
    try {
      credits = await this.creditRepository.find();
    } catch (err) {
      this.logger.error(
        `[#1321] Failed to load credits: ${(err as Error).message}`,
      );
      return;
    }

    const creditOwnerMap = new Map(credits.map((c) => [c.id, c.owner]));

    // Detection: 2-party loops (A→B→A) and 3-party loops (A→B→C→A).
    for (const [creditId, trades] of tradesByCredit.entries()) {
      const currentOwner = creditOwnerMap.get(creditId);
      if (!currentOwner) continue;

      // Collect all unique buyers seen in the window for this credit.
      const buyers = trades.map((t) => t.to);

      // 2-party loop: issuer/seller of a retirement is the current owner,
      // meaning the credit has cycled back.
      // Since we don't have the `from` field, detect by checking whether
      // the current owner appears as a buyer in a prior retirement within
      // the window (i.e., they once received it, then sold and re-acquired it).
      if (this.has2PartyLoop(buyers, currentOwner)) {
        newSuspicious.add(creditId);
        this.logger.warn(
          `[#1321] Potential wash trade detected (2-party loop) for credit ${creditId} — ` +
            `current owner ${currentOwner} appears in buyer history within the window`,
        );
        continue;
      }

      // 3-party loop: check for A→B→C→A cycles among the buyers.
      if (this.has3PartyLoop(buyers, currentOwner)) {
        newSuspicious.add(creditId);
        this.logger.warn(
          `[#1321] Potential wash trade detected (3-party loop) for credit ${creditId}`,
        );
      }
    }

    this.suspiciousCreditIds = newSuspicious;
    this.logger.log(
      `[#1321] Wash-trade scan complete — ${newSuspicious.size} suspicious credit(s) flagged`,
    );
  }

  // ── Detection helpers ──────────────────────────────────────────────────────

  /**
   * Returns true if `currentOwner` appears in the `buyers` list, indicating
   * the credit has returned to them (A→…→A).
   */
  private has2PartyLoop(buyers: string[], currentOwner: string): boolean {
    return buyers.includes(currentOwner);
  }

  /**
   * Returns true if there is a 3-party cycle in `buyers` including `currentOwner`.
   * Uses a simple set-intersection approach: if any buyer in the list also
   * appears as a predecessor in the chain, we have a cycle.
   *
   * With only buyer addresses (no explicit seller chain), this checks whether
   * the same address appears at least twice in the buyer list (indicating it
   * received and then sent the credit back into the pool more than once).
   */
  private has3PartyLoop(buyers: string[], currentOwner: string): boolean {
    const seen = new Set<string>();
    for (const b of buyers) {
      if (seen.has(b)) {
        // Address appears as buyer more than once — indicative of a cycle.
        return true;
      }
      seen.add(b);
    }
    // Check if 3 or more distinct parties form a closed loop back to currentOwner.
    return seen.size >= 3 && seen.has(currentOwner);
  }

  // ── Public query API ───────────────────────────────────────────────────────

  /** Returns true if `creditId` was flagged in the most recent detection run. */
  isSuspicious(creditId: string): boolean {
    return this.suspiciousCreditIds.has(creditId);
  }

  /** Returns all currently flagged credit IDs. */
  getSuspiciousCreditIds(): string[] {
    return Array.from(this.suspiciousCreditIds);
  }

  // ── OHLCV candles stub ─────────────────────────────────────────────────────

  /**
   * Returns OHLCV candle data for the given parameters, excluding wash-trade
   * credits.
   *
   * This method is a stub: in production it would query a dedicated
   * `price_history` or `trade_candles` table (populated by an ingestion
   * pipeline) and filter out rows where `credit_id` is in
   * `getSuspiciousCreditIds()`.  Because no such table exists in the current
   * schema, it returns an empty array.
   *
   * @param _params - Query parameters (creditId, from, to, interval). Unused
   *   in this stub implementation.
   * @returns Empty array until a price-history table is available.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getOhlcvCandles(_params: OhlcvParams): CandleData[] {
    // TODO: query a price_history table, apply time-range and interval
    // aggregation, then filter out creditIds present in
    // this.getSuspiciousCreditIds().
    return [];
  }
}
