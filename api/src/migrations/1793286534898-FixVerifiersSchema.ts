import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: FixVerifiersSchema
 *
 * `CreateTables1748304000000` creates a legacy `verifiers` table
 * (address + created_at), and `CreateVerifiersTable1748476900000` uses
 * `CREATE TABLE IF NOT EXISTS`, so on a database that applied both
 * migrations in order the richer columns are never added.
 *
 * This migration upgrades the pre-existing table in place so it matches
 * `VerifierEntity`. All statements are idempotent.
 */
export class FixVerifiersSchema1793286534898 implements MigrationInterface {
  name = 'FixVerifiersSchema1793286534898';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE verifiers
        ADD COLUMN IF NOT EXISTS name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS reputation JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS unstable BOOLEAN NOT NULL DEFAULT FALSE;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE verifiers
        DROP COLUMN IF EXISTS name,
        DROP COLUMN IF EXISTS capabilities,
        DROP COLUMN IF EXISTS reputation,
        DROP COLUMN IF EXISTS registered_at,
        DROP COLUMN IF EXISTS synced_at,
        DROP COLUMN IF EXISTS unstable;
    `);
  }
}
