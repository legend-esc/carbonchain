import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddCreditIndexes
 *
 * Adds targeted indexes to the `credits` table to prevent full table scans
 * when filtering by status, methodology, geography, vintage_year, or owner_address.
 *
 * Composite index on (status, methodology, geography) covers the most common
 * multi-field filter combination used in the marketplace and verifier queue.
 *
 * Run:  npx typeorm migration:run -d src/data-source.ts
 * Undo: npx typeorm migration:revert -d src/data-source.ts
 */
export class AddCreditIndexes1748390400000 implements MigrationInterface {
  name = 'AddCreditIndexes1748390400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Composite index for the most common marketplace filter combination
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_credits_status_methodology_geography
        ON credits (status, methodology, geography);
    `);

    // Single-column index for vintage year range queries
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_credits_vintage_year
        ON credits (vintage_year);
    `);

    // Index for owner/issuer address lookups (portfolio queries)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_credits_owner_address
        ON credits (issuer);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_credits_status_methodology_geography;`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_credits_vintage_year;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_credits_owner_address;`);
  }
}
