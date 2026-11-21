import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

/**
 * PartitionCleanupTask
 *
 * Scheduled maintenance for the `events_partitioned` table:
 *
 *  - 25th of each month  → create the partition for next month.
 *  - 1st of each month   → drop (archive) the partition that is 12 months old.
 *
 * Real archival to S3/Glacier before dropping would be wired here as a TODO.
 */
@Injectable()
export class PartitionCleanupTask {
  private readonly logger = new Logger(PartitionCleanupTask.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Runs on the 25th of each month at midnight.
   * Creates the partition that will hold next month's events.
   */
  @Cron('0 0 25 * *')
  async createNextMonthPartition(): Promise<void> {
    const now = new Date();
    // Advance one month.
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const after = new Date(now.getFullYear(), now.getMonth() + 2, 1);

    const partName = this.partitionName(next);
    const fromStr = this.isoMonth(next);
    const toStr = this.isoMonth(after);

    this.logger.log(
      `Creating partition ${partName} FOR VALUES FROM ('${fromStr}') TO ('${toStr}')`,
    );

    const sql = `
      CREATE TABLE IF NOT EXISTS ${partName}
        PARTITION OF events_partitioned
        FOR VALUES FROM ('${fromStr}') TO ('${toStr}')
    `;

    try {
      await this.dataSource.query(sql);
      this.logger.log(`Partition ${partName} created successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to create partition ${partName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Runs on the 1st of each month at 02:00.
   * Drops the partition from 12 months ago (represents archival).
   *
   * TODO: Before dropping, export the partition to S3/Glacier so data is
   *       preserved for audit purposes.
   */
  @Cron('0 2 1 * *')
  async archiveOldPartitions(): Promise<void> {
    const now = new Date();
    // Go back 12 months.
    const old = new Date(now.getFullYear(), now.getMonth() - 12, 1);
    const partName = this.partitionName(old);

    this.logger.log(
      `Archiving (dropping) partition ${partName} — 12-month retention policy`,
    );

    // TODO: archive partition data to S3/Glacier before dropping.
    const sql = `DROP TABLE IF EXISTS ${partName}`;

    try {
      await this.dataSource.query(sql);
      this.logger.log(`Partition ${partName} dropped`);
    } catch (error) {
      this.logger.error(
        `Failed to drop partition ${partName}: ${(error as Error).message}`,
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Partition table name for a given Date, e.g. `events_p_2024_03`. */
  private partitionName(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `events_p_${year}_${month}`;
  }

  /** ISO month boundary string suitable for SQL range, e.g. `2024-03-01`. */
  private isoMonth(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
  }
}
