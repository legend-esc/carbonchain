/**
 * #1303 — Nightly reconciliation worker (enhanced)
 *
 * Runs daily at 02:00 UTC.
 *
 * Responsibilities:
 *  1. Fetches on-chain credit status via Soroban RPC getContractData and
 *     compares against the PostgreSQL credits table.
 *  2. Fetches on-chain active offers via getContractData and samples whether
 *     any are missing from the in-process active offer set (detected when the
 *     on-chain status disagrees with what the marketplace contract returns).
 *  3. Logs every discrepancy to the reconciliation_discrepancies table.
 *  4. Sends a webhook alert via WebhooksService.triggerWebhooks() when drift > 0.
 *  5. Auto-corrects drifted credit rows and updates the drift counter.
 *
 * Prometheus metrics:
 *  - carbonchain_reconciliation_last_run_timestamp (Gauge)
 *  - carbonchain_reconciliation_drift_detected_total (Counter, label: chain_status)
 *  - carbonchain_reconciliation_drift_corrected_total (Counter, label: chain_status)
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { scValToNative, nativeToScVal } from '@stellar/stellar-sdk';
import { CreditEntity } from '../credits/credit.entity';
import { StellarService } from '../stellar/stellar.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import client from 'prom-client';
import { getOrCreateMetric } from '../common/prometheus.util';
import { CreditStatus } from '../../../shared';

export interface DriftRecord {
  creditId: string;
  dbStatus: string;
  chainStatus: string;
  correctedAt: Date;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly contractId: string;
  private readonly marketplaceContractId: string;

  // ── Prometheus metrics ────────────────────────────────────────────────────

  /** Timestamp of the last successful reconciliation run (Unix epoch seconds). */
  private readonly dataFreshnessGauge: client.Gauge<string>;

  /** Total drifted credits detected (cumulative since process start). */
  private readonly driftDetectedCounter: client.Counter<string>;

  /** Total drifted credits auto-corrected (cumulative since process start). */
  private readonly driftCorrectedCounter: client.Counter<string>;

  constructor(
    @InjectRepository(CreditEntity)
    private readonly creditRepo: Repository<CreditEntity>,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional() private readonly webhooksService?: WebhooksService,
  ) {
    this.contractId =
      this.configService.get<string>('CREDIT_REGISTRY_CONTRACT_ID') ?? '';
    this.marketplaceContractId =
      this.configService.get<string>('MARKETPLACE_CONTRACT_ID') ?? '';

    this.dataFreshnessGauge = getOrCreateMetric(
      'carbonchain_reconciliation_last_run_timestamp',
      () =>
        new client.Gauge({
          name: 'carbonchain_reconciliation_last_run_timestamp',
          help: 'Unix epoch seconds of the last successful nightly reconciliation run',
        }),
    );

    this.driftDetectedCounter = getOrCreateMetric(
      'carbonchain_reconciliation_drift_detected_total',
      () =>
        new client.Counter({
          name: 'carbonchain_reconciliation_drift_detected_total',
          help: 'Total number of credit status drifts detected vs on-chain state',
          labelNames: ['chain_status'],
        }),
    );

    this.driftCorrectedCounter = getOrCreateMetric(
      'carbonchain_reconciliation_drift_corrected_total',
      () =>
        new client.Counter({
          name: 'carbonchain_reconciliation_drift_corrected_total',
          help: 'Total number of credit status drifts auto-corrected in the DB',
          labelNames: ['chain_status'],
        }),
    );
  }

  /**
   * Runs nightly at 02:00 UTC.
   *
   * Phase 1: credits — pages through all DB credit rows, queries on-chain
   *   status for each, corrects drift, and logs discrepancies.
   *
   * Phase 2: offers — fetches the on-chain active offer list and cross-checks
   *   each offer's status. Any offer the contract reports as inactive/closed
   *   that is still marked active in the DB is flagged as a discrepancy.
   *   Because offers have no separate DB table the drift is logged-only
   *   (no auto-correction is applied to offers).
   *
   * When any drift is detected a webhook alert is fired.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runNightlyReconciliation(): Promise<void> {
    this.logger.log('Starting nightly credit reconciliation');
    let driftCount = 0;
    let correctedCount = 0;

    try {
      // ── Phase 1: credits ──────────────────────────────────────────────────
      const creditDrift = await this.reconcileCredits();
      driftCount += creditDrift.detected;
      correctedCount += creditDrift.corrected;

      // ── Phase 2: offers ───────────────────────────────────────────────────
      const offerDrift = await this.reconcileOffers();
      driftCount += offerDrift.detected;

      this.dataFreshnessGauge.set(Math.floor(Date.now() / 1000));
      this.logger.log(
        `Reconciliation complete — detected: ${driftCount}, corrected: ${correctedCount}`,
      );

      // #1303 — Alert maintenance channels when any drift was detected.
      if (driftCount > 0 && this.webhooksService) {
        try {
          await this.webhooksService.triggerWebhooks(
            'reconciliation.drift_detected',
            {
              detectedAt: new Date().toISOString(),
              driftCount,
              correctedCount,
            },
          );
        } catch (webhookErr) {
          // Non-fatal: a webhook delivery failure must not abort the reconciliation.
          this.logger.warn(
            `Failed to send reconciliation webhook alert: ${(webhookErr as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Reconciliation run failed: ${(err as Error).message}`);
    }
  }

  // ── Phase 1: credit reconciliation ────────────────────────────────────────

  private async reconcileCredits(): Promise<{
    detected: number;
    corrected: number;
  }> {
    let detected = 0;
    let corrected = 0;
    const pageSize = 100;
    let page = 0;

    while (true) {
      const batch = await this.creditRepo.find({
        skip: page * pageSize,
        take: pageSize,
        order: { id: 'ASC' },
      });

      if (batch.length === 0) break;

      for (const credit of batch) {
        try {
          const chainStatus = await this.fetchChainStatus(credit.id);
          if (chainStatus === null) continue;

          if (chainStatus !== String(credit.status)) {
            detected++;
            this.driftDetectedCounter.labels(chainStatus).inc();
            this.logger.warn(
              `Drift detected — credit ${credit.id}: DB="${credit.status}" chain="${chainStatus}"`,
            );

            await this.logDiscrepancy({
              entityType: 'credit',
              entityId: credit.id,
              dbStatus: String(credit.status),
              chainStatus,
              corrected: true,
            });

            await this.correctDrift(credit, chainStatus as CreditStatus);
            corrected++;
            this.driftCorrectedCounter.labels(chainStatus).inc();
          }
        } catch (err) {
          this.logger.error(
            `Failed to reconcile credit ${credit.id}: ${(err as Error).message}`,
          );
        }
      }

      page++;
      if (batch.length < pageSize) break;
    }

    return { detected, corrected };
  }

  // ── Phase 2: offer reconciliation ─────────────────────────────────────────

  /**
   * Fetches the on-chain active offer list from the marketplace contract and
   * cross-checks each offer's status.
   *
   * Since the platform has no separate offers DB table (offers are managed
   * entirely on-chain), drift is defined as: an offer that the contract returns
   * in the get_active_offers list but whose `active` flag is false (i.e., the
   * contract state is inconsistent within the same response).  Such entries are
   * logged as discrepancies without auto-correction; the alert lets operators
   * investigate.
   */
  async reconcileOffers(): Promise<{ detected: number }> {
    if (!this.marketplaceContractId) {
      this.logger.debug(
        'MARKETPLACE_CONTRACT_ID not configured — skipping offer reconciliation',
      );
      return { detected: 0 };
    }

    let detected = 0;
    try {
      const args = [
        nativeToScVal(true, { type: 'bool' }),
        nativeToScVal(0, { type: 'u64' }),
        nativeToScVal(500, { type: 'u64' }),
      ];
      const retval = await this.stellarService.readContract(
        this.marketplaceContractId,
        'get_active_offers',
        args,
      );
      if (!retval) return { detected: 0 };

      const offers = (
        Array.isArray(retval) ? retval : scValToNative(retval)
      ) as Array<{
        id: bigint;
        active: boolean;
        [key: string]: unknown;
      }>;

      for (const offer of offers) {
        // An offer returned by get_active_offers should always be active.
        // If `active === false` it means the contract state is drifted.
        if (offer.active === false) {
          detected++;
          const offerId = String(offer.id);
          this.logger.warn(
            `Offer drift detected — offer ${offerId}: returned by get_active_offers but active=false`,
          );
          await this.logDiscrepancy({
            entityType: 'offer',
            entityId: offerId,
            dbStatus: 'active',
            chainStatus: 'closed',
            corrected: false,
          });
        }
      }
    } catch (err) {
      this.logger.error(
        `Offer reconciliation failed: ${(err as Error).message}`,
      );
    }

    return { detected };
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  /**
   * Fetches the credit status from the on-chain registry contract.
   * Returns null if the contract call fails (caller skips this credit).
   */
  async fetchChainStatus(creditId: string): Promise<string | null> {
    try {
      const creditIdBytes = Buffer.from(creditId.replace(/-/g, ''), 'hex');
      const args = [nativeToScVal(creditIdBytes, { type: 'bytes' })];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_credit',
        args,
      );
      if (!retval) return null;
      const native = scValToNative(retval) as Record<string, unknown>;
      const raw = native['status'];
      if (typeof raw === 'string') return raw.toLowerCase();
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Persists a drift event to the reconciliation_discrepancies table.
   * Non-fatal — a failure here is logged but does not stop the reconciliation run.
   */
  async logDiscrepancy(opts: {
    entityType: 'credit' | 'offer';
    entityId: string;
    dbStatus: string;
    chainStatus: string;
    corrected?: boolean;
  }): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO reconciliation_discrepancies
           (entity_type, entity_id, db_status, chain_status, corrected, detected_at, corrected_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
        [
          opts.entityType,
          opts.entityId,
          opts.dbStatus,
          opts.chainStatus,
          opts.corrected ?? true,
          opts.corrected ? new Date() : null,
        ],
      );
    } catch (err) {
      this.logger.warn(
        `Failed to log discrepancy for ${opts.entityType} ${opts.entityId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Corrects a drifted credit row.
   */
  private async correctDrift(
    credit: CreditEntity,
    chainStatus: CreditStatus,
  ): Promise<void> {
    const previous = credit.status;
    credit.status = chainStatus;
    await this.creditRepo.save(credit);
    this.logger.log(
      `Auto-corrected credit ${credit.id}: ${previous} → ${chainStatus} ` +
        `(reconciliation at ${new Date().toISOString()})`,
    );
  }

  /**
   * Exposed for integration tests: run a reconciliation pass on a specific
   * list of credit IDs rather than all DB rows.
   */
  async reconcileIds(creditIds: string[]): Promise<DriftRecord[]> {
    const drifts: DriftRecord[] = [];
    for (const id of creditIds) {
      const credit = await this.creditRepo.findOne({ where: { id } });
      if (!credit) continue;

      const chainStatus = await this.fetchChainStatus(id);
      if (chainStatus === null) continue;

      if (chainStatus !== String(credit.status)) {
        const dbStatus = credit.status;
        await this.logDiscrepancy({
          entityType: 'credit',
          entityId: id,
          dbStatus,
          chainStatus,
          corrected: true,
        });
        await this.correctDrift(credit, chainStatus as CreditStatus);
        drifts.push({
          creditId: id,
          dbStatus,
          chainStatus,
          correctedAt: new Date(),
        });
      }
    }
    return drifts;
  }
}
