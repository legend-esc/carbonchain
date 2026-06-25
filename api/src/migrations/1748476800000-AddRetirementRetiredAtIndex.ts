import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRetirementRetiredAtIndex1748476800000 implements MigrationInterface {
  name = 'AddRetirementRetiredAtIndex1748476800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_retirements_retired_at
        ON retirements (retired_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_retirements_retired_at;`);
  }
}
