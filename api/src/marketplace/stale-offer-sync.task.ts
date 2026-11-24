/**
 * #1308 — Background job for automated stale marketplace offer indexing.
 *
 * Runs every 10 minutes via @Cron. Queries the database for offers where
 * `expires_at < NOW() AND status = 'ACTIVE'`, updates them to 'EXPIRED',
 * and broadcasts a WebSocket `offer.expired` event for each affected offer.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MarketplaceGateway } from './marketplace.gateway';

/** Shape of a row returned by the stale-offer query. */
interface StaleOfferRow {
  id: string;
  seller: string;
  credit_id: string;
  expires_at: Date;
}

@Injectable()
export class StaleOfferSyncTask {
  private readonly logger = new Logger(StaleOfferSyncTask.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly gateway: MarketplaceGateway,
  ) {}

  /**
   * Run every 10 minutes.
   *
   * Uses an atomic UPDATE … RETURNING to avoid a separate SELECT + UPDATE
   * race: only rows that are still ACTIVE at update time are changed.
   * The RETURNING clause gives us the IDs to broadcast without a second query.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncStaleOffers(): Promise<void> {
    this.logger.log('StaleOfferSyncTask: checking for expired offers');

    let expired: StaleOfferRow[] = [];

    try {
      // Atomically flip ACTIVE → EXPIRED for all past-deadline offers and
      // return the affected rows so we can broadcast events.
      const result = await this.dataSource.query<StaleOfferRow[]>(
        `UPDATE marketplace_offers
            SET status = 'EXPIRED'
          WHERE status = 'ACTIVE'
            AND expires_at IS NOT NULL
            AND expires_at < NOW()
          RETURNING id, seller, credit_id, expires_at`,
      );

      // node-postgres raw queries return [rows[], rowCount] — take index 0.
      expired = Array.isArray(result) && Array.isArray(result[0])
        ? (result[0] as StaleOfferRow[])
        : (result as StaleOfferRow[]);
    } catch (err) {
      this.logger.error(
        `StaleOfferSyncTask: DB update failed — ${(err as Error).message}`,
      );
      return;
    }

    if (expired.length === 0) {
      this.logger.debug('StaleOfferSyncTask: no stale offers found');
      return;
    }

    this.logger.log(
      `StaleOfferSyncTask: expired ${expired.length} offer(s): ` +
        expired.map((o) => o.id).join(', '),
    );

    // Broadcast offer.expired WebSocket event for each affected offer.
    for (const offer of expired) {
      this.gateway.broadcastOfferExpired(offer.id, offer.seller);
    }
  }
}
