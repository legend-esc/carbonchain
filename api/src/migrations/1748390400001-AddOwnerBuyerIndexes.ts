import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddOwnerBuyerIndexes
 *
 * GET /api/v1/credits?owner=G... does a sequential scan because
 * AddCreditIndexes (1748390400000) only indexed status/vintage_year/issuer.
 * Adds a composite (owner, status) index for the common owner+status filter
 * pattern, plus an index on retirements.buyer for retirement lookups.
 *
 * Verify with:
 *   EXPLAIN ANALYZE SELECT * FROM credits WHERE owner = '...' AND status = '...';
 *
 * Run:  npx typeorm migration:run -d src/data-source.ts
 * Undo: npx typeorm migration:revert -d src/data-source.ts
 */
export class AddOwnerBuyerIndexes1748390400001 implements MigrationInterface {
  name = 'AddOwnerBuyerIndexes1748390400001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_credits_owner_status
        ON credits (owner, status);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_retirements_buyer
        ON retirements (buyer);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_credits_owner_status;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_retirements_buyer;`);
  }
}
