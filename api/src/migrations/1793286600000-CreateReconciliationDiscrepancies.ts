/**
 * #1303 — Creates the reconciliation_discrepancies table.
 *
 * Each row records one drift event detected during a nightly reconciliation
 * run: the credit or offer whose on-chain status diverges from the database
 * record. The table is append-only; the correction applied is logged here for
 * audit purposes.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReconciliationDiscrepancies1793286600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reconciliation_discrepancies" (
        "id"              BIGSERIAL    PRIMARY KEY,
        "entity_type"     VARCHAR(32)  NOT NULL,
        "entity_id"       VARCHAR(128) NOT NULL,
        "db_status"       VARCHAR(64)  NOT NULL,
        "chain_status"    VARCHAR(64)  NOT NULL,
        "corrected"       BOOLEAN      NOT NULL DEFAULT FALSE,
        "detected_at"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "corrected_at"    TIMESTAMPTZ
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reconciliation_discrepancies_entity"
        ON "reconciliation_discrepancies" ("entity_type", "entity_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reconciliation_discrepancies_detected_at"
        ON "reconciliation_discrepancies" ("detected_at" DESC);
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "reconciliation_discrepancies"`,
    );
  }
}
