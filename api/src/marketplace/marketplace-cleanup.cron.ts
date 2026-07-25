import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MarketplaceService } from './marketplace.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Issue: expired marketplace offers accumulate in contract storage because
 * clean_expired_offers() requires a manual, gas-paying caller. This cron
 * automates that call on an hourly schedule using the admin keypair.
 *
 * NOTE: not yet wired into MarketplaceModule providers — add it there and
 * inject the Soroban RPC client used by MarketplaceService before enabling.
 */
@Injectable()
export class MarketplaceCleanupCron {
  private readonly logger = new Logger(MarketplaceCleanupCron.name);
  private readonly BATCH_SIZE = 100;
  private readonly PENDING_ALERT_THRESHOLD = 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly marketplaceService: MarketplaceService,
    private readonly adminKeypair: StellarKeypairService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanExpiredOffers(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    let gasSpent = 0;

    try {
      const activeOfferIds = await this.marketplaceService.getActiveOfferIds();
      const expiredIds = await this.filterExpired(activeOfferIds, now);

      if (expiredIds.length > this.PENDING_ALERT_THRESHOLD) {
        this.logger.error(
          `marketplace cleanup backlog alert: ${expiredIds.length} expired offers pending (threshold ${this.PENDING_ALERT_THRESHOLD})`,
        );
      }

      for (let i = 0; i < expiredIds.length; i += this.BATCH_SIZE) {
        const batch = expiredIds.slice(i, i + this.BATCH_SIZE);
        const startId = batch[0];

        const result = await this.marketplaceService.cleanExpiredOffers(
          startId,
          batch.length,
          this.adminKeypair,
        );

        removed += result.removedCount;
        gasSpent += result.feeCharged;
      }

      this.metrics.increment('marketplace.cleanup.offers_removed', removed);
      this.metrics.increment('marketplace.cleanup.gas_spent', gasSpent);
      this.logger.log(
        `marketplace cleanup: removed=${removed} gasSpent=${gasSpent}`,
      );
    } catch (err) {
      this.logger.error('marketplace cleanup cron failed', err as Error);
    }
  }

  private async filterExpired(
    offerIds: string[],
    now: number,
  ): Promise<string[]> {
    const offers = await this.marketplaceService.getOffersByIds(offerIds);
    return offers.filter((o) => o.expiresAt != null && o.expiresAt < now).map((o) => o.id);
  }
}
