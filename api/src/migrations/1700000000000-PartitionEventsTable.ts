import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PartitionEventsTable1700000000000
 *
 * Creates a declarative range-partitioned shadow table `events_partitioned`
 * alongside the existing `events` table.  A catch-all DEFAULT partition
 * (`events_p_default`) is created for portability across PostgreSQL versions
 * that do not support per-month partition creation at migration time.
 *
 * Monthly partitions are created and old ones archived by PartitionCleanupTask
 * (see partition-cleanup.task.ts).
 */
export class PartitionEventsTable1700000000000 implements MigrationInterface {
  name = 'PartitionEventsTable1700000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create the partitioned parent table.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS events_partitioned (
        id            VARCHAR(255)  NOT NULL,
        contract_id   VARCHAR(100)  NOT NULL,
        event_type    VARCHAR(100)  NOT NULL,
        ledger        BIGINT        NOT NULL,
        tx_hash       VARCHAR(100),
        timestamp     BIGINT        NOT NULL,
        data          JSONB         NOT NULL,
        created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ledger_date   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (id, ledger_date)
      ) PARTITION BY RANGE (ledger_date)
    `);

    // 2. Default catch-all partition — receives rows not covered by explicit
    //    monthly partitions.  Keeps the migration portable without computing
    //    month boundaries in TypeScript.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS events_p_default
        PARTITION OF events_partitioned DEFAULT
    `);

    // 3. Indexes on the partitioned table.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_events_part_contract_id
        ON events_partitioned (contract_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_events_part_event_type
        ON events_partitioned (event_type)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_events_part_ledger
        ON events_partitioned (ledger)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS events_partitioned CASCADE`,
    );
  }
}
