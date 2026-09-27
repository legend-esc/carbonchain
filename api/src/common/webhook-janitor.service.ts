/**
 * #935 — WebhookJanitorService
 *
 * Background garbage-collector for the in-memory webhook delivery log.
 * The deliveries Map in WebhooksService grows with every event; without
 * lifecycle management it becomes an unbounded data structure and the
 * queue scan (processQueue) degrades from O(1) to O(n) over time.
 *
 * Design:
 *  • Retention window: configurable via WEBHOOK_RETENTION_DAYS env var
 *    (default 30 days).  Records older than this cutoff are deleted.
 *  • Watermark: the janitor tracks the highest delivery `id` it has ever
 *    processed so that processQueue scans start from a known-clean point
 *    rather than re-visiting old records on every tick.
 *  • Idempotency: multiple concurrent janitor runs are safe because purgeOld
 *    is guarded by a running-flag; a second call before the first completes
 *    is a no-op and returns 0 deleted.
 *  • Scheduling: setInterval starts on onModuleInit and is cleared on
 *    onModuleDestroy so there are no leaked timers in tests.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WebhookDelivery } from '../webhooks/webhooks.service';
import { WebhooksService } from '../webhooks/webhooks.service';

/** Default retention period in days when WEBHOOK_RETENTION_DAYS is not set. */
export const DEFAULT_RETENTION_DAYS = 30;

/** Default janitor run interval in milliseconds (1 hour). */
export const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface JanitorStats {
  /** Retention window in days currently in use. */
  retentionDays: number;
  /** Number of deliveries deleted in the most recent purge run. */
  lastPurgedCount: number;
  /** Timestamp of the most recent purge (undefined if never run). */
  lastRunAt?: Date;
  /** Highest delivery ID seen so far (watermark). */
  watermark: string;
}

@Injectable()
export class WebhookJanitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookJanitorService.name);

  private retentionDays: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  private lastPurgedCount = 0;
  private lastRunAt?: Date;
  /** Highest delivery id seen so watermark advances monotonically. */
  private watermark = '';

  constructor(
    private readonly configService: ConfigService,
    private readonly webhooksService: WebhooksService,
  ) {
    this.retentionDays = Number(
      this.configService.get<number>(
        'WEBHOOK_RETENTION_DAYS',
        DEFAULT_RETENTION_DAYS,
      ),
    );
    this.intervalMs = Number(
      this.configService.get<number>(
        'WEBHOOK_JANITOR_INTERVAL_MS',
        DEFAULT_INTERVAL_MS,
      ),
    );
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.purgeOld();
    }, this.intervalMs);

    this.logger.log(
      `WebhookJanitorService started — retentionDays=${this.retentionDays}, ` +
        `intervalMs=${this.intervalMs}`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Delete all delivery records whose createdAt is older than the current
   * retention window.
   *
   * Idempotent: if a prior run is still executing the call returns 0 without
   * waiting, keeping the queue scan cost constant even under high throughput.
   *
   * @returns Number of records deleted.
   */
  async purgeOld(): Promise<number> {
    if (this.running) {
      this.logger.debug(
        'WebhookJanitorService: purge already running, skipping',
      );
      return 0;
    }

    this.running = true;
    let deleted = 0;

    try {
      const cutoff = new Date(
        Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
      );

      const all: WebhookDelivery[] = this.webhooksService.getDeliveries();
      const toDelete = all.filter((d) => d.createdAt < cutoff);

      for (const delivery of toDelete) {
        this.webhooksService.deleteDelivery(delivery.id);
        deleted++;

        // Advance watermark to the highest id encountered.
        if (!this.watermark || delivery.id > this.watermark) {
          this.watermark = delivery.id;
        }
      }

      this.lastPurgedCount = deleted;
      this.lastRunAt = new Date();

      if (deleted > 0) {
        this.logger.log(
          `WebhookJanitorService purged ${deleted} deliveries older than ` +
            `${this.retentionDays} days (cutoff=${cutoff.toISOString()})`,
        );
      } else {
        this.logger.debug(
          `WebhookJanitorService: no deliveries to purge (cutoff=${cutoff.toISOString()})`,
        );
      }
    } finally {
      this.running = false;
    }

    return deleted;
  }

  /**
   * Update the retention window at runtime without restarting the service.
   * Used by the POST /webhooks/retention endpoint.
   */
  setRetentionDays(days: number): void {
    if (days <= 0) {
      throw new RangeError(
        `WebhookJanitorService.setRetentionDays: days must be > 0, got ${days}`,
      );
    }
    this.retentionDays = days;
    this.logger.log(`WebhookJanitorService: retention updated to ${days} days`);
  }

  /** Read-only stats snapshot for the retention endpoint and admin panel. */
  getStats(): JanitorStats {
    return {
      retentionDays: this.retentionDays,
      lastPurgedCount: this.lastPurgedCount,
      lastRunAt: this.lastRunAt,
      watermark: this.watermark,
    };
  }
}
