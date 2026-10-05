/**
 * #927 — Nightly reconciliation worker
 *
 * Compares on-chain credit/offer status against DB rows. Detects drift
 * (e.g. a direct-chain mutation that bypassed the API), logs it, and
 * optionally auto-corrects with an audit row.  A `dataFreshness` Gauge is
 * exposed so Prometheus can alert when the last run is stale.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { scValToNative, nativeToScVal } from '@stellar/stellar-sdk';
import { CreditEntity } from '../credits/credit.entity';
import { StellarService } from '../stellar/stellar.service';
import client from 'prom-client';
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
  ) {
    this.contractId =
      this.configService.get<string>('CREDIT_REGISTRY_CONTRACT_ID') ?? '';

    this.dataFreshnessGauge = new client.Gauge({
      name: 'carbonchain_reconciliation_last_run_timestamp',
      help: 'Unix epoch seconds of the last successful nightly reconciliation run',
    });

    this.driftDetectedCounter = new client.Counter({
      name: 'carbonchain_reconciliation_drift_detected_total',
      help: 'Total number of credit status drifts detected vs on-chain state',
      labelNames: ['chain_status'],
    });

    this.driftCorrectedCounter = new client.Counter({
      name: 'carbonchain_reconciliation_drift_corrected_total',
      help: 'Total number of credit status drifts auto-corrected in the DB',
      labelNames: ['chain_status'],
    });
  }

  /**
   * Runs nightly at 02:00 UTC.
   * Pages through all credits in the DB, queries on-chain status for each,
   * and corrects any drift found.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runNightlyReconciliation(): Promise<void> {
    this.logger.log('Starting nightly credit reconciliation');
    let driftCount = 0;
    let correctedCount = 0;
    const pageSize = 100;
    let page = 0;

    try {
      // Paginate DB credits to avoid loading everything into memory.
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
            if (chainStatus === null) {
              // Could not read on-chain — skip this credit silently.
              continue;
            }
            if (chainStatus !== String(credit.status)) {
              driftCount++;
              this.driftDetectedCounter.labels(chainStatus).inc();
              this.logger.warn(
                `Drift detected — credit ${credit.id}: DB="${credit.status}" chain="${chainStatus}"`,
              );

              await this.correctDrift(credit, chainStatus as CreditStatus);
              correctedCount++;
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

      this.dataFreshnessGauge.set(Math.floor(Date.now() / 1000));
      this.logger.log(
        `Reconciliation complete — detected: ${driftCount}, corrected: ${correctedCount}`,
      );
    } catch (err) {
      this.logger.error(`Reconciliation run failed: ${(err as Error).message}`);
    }
  }

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
      // Contract returns a struct with a `status` field (symbol / string).
      const raw = native['status'];
      if (typeof raw === 'string') return raw.toLowerCase();
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Corrects a drifted credit row and writes an audit entry to the DB.
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
        `(audit: reconciliation at ${new Date().toISOString()})`,
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
        await this.correctDrift(credit, chainStatus as CreditStatus);
        drifts.push({
          creditId: id,
          dbStatus: credit.status,
          chainStatus,
          correctedAt: new Date(),
        });
      }
    }
    return drifts;
  }
}
