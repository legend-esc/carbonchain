import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #589 — Add vintage_year column to the retirements table.
 *
 * The column stores the vintage year of the carbon credit at retirement time
 * so that the off-chain certificate can display full provenance without an
 * extra registry lookup. Defaults to 0 for legacy records that pre-date this
 * field.
 */
export class AddRetirementVintageYear1753660800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "retirements"
      ADD COLUMN IF NOT EXISTS "vintageYear" INT NOT NULL DEFAULT 0;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "retirements"
      DROP COLUMN IF EXISTS "vintageYear";
    `);
  }
}
