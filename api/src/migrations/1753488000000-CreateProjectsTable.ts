import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateProjectsTable
 *
 * Creates the `projects` table to persist project metadata.
 * The `id` column uses UUID v4 with a unique constraint.
 *
 * Run:  npx typeorm migration:run -d src/data-source.ts
 * Undo: npx typeorm migration:revert -d src/data-source.ts
 */
export class CreateProjectsTable1753488000000 implements MigrationInterface {
  name = 'CreateProjectsTable1753488000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        developer VARCHAR(255),
        description TEXT,
        location VARCHAR(255),
        methodology VARCHAR(255),
        documents_cid VARCHAR(255) DEFAULT ''
      );
    `);

    // Add unique constraint on id (already PRIMARY KEY, but explicit for clarity)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_id_unique
        ON projects (id);
    `);

    // Index for name-based searches
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_name
        ON projects (name);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_projects_name;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_projects_id_unique;`);
    await queryRunner.query(`DROP TABLE IF EXISTS projects;`);
  }
}
