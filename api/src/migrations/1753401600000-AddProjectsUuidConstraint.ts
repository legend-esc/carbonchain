import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddProjectsUuidConstraint
 *
 * Issue #484: projects.service.ts previously generated IDs with Math.random()
 * (only ~46 bits of entropy, no collision guarantee). This migration:
 *
 *   1. Creates the `projects` table with `id` as a UUID primary key, enforcing
 *      the unique constraint at the database level so duplicate IDs cause a
 *      constraint violation instead of silently overwriting an existing row.
 *   2. Adds a unique index on `id` explicitly (belt-and-suspenders; the PRIMARY
 *      KEY constraint already implies uniqueness, but the explicit index makes
 *      the intent visible to operators and query planners).
 *
 * The service now calls `crypto.randomUUID()` (Node.js 14.17+/18+) so every
 * new project receives a v4 UUID.
 *
 * Note: On-chain project IDs registered via `register_project` on the Soroban
 * contract are independent string keys chosen by the caller. This migration
 * does NOT change the on-chain ID format — existing on-chain state is
 * unaffected.
 *
 * Run:  npx typeorm migration:run -d src/data-source.ts
 * Undo: npx typeorm migration:revert -d src/data-source.ts
 */
export class AddProjectsUuidConstraint1753401600000
  implements MigrationInterface
{
  name = 'AddProjectsUuidConstraint1753401600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create the projects table if it does not already exist.
    // The `id` column is a UUID primary key — the PRIMARY KEY constraint
    // implicitly enforces uniqueness and creates a B-tree index.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        name         VARCHAR(255) NOT NULL,
        developer    VARCHAR(255) NOT NULL,
        description  TEXT         NOT NULL,
        location     VARCHAR(255) NOT NULL,
        methodology  VARCHAR(100) NOT NULL,
        documents_cid VARCHAR(255) NOT NULL DEFAULT ''
      );
    `);

    // Explicit unique index on `id` — makes the constraint visible to
    // monitoring/ops tooling and allows use of ON CONFLICT (id) clauses.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_id
        ON projects (id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_projects_id;`);
    await queryRunner.query(`DROP TABLE IF EXISTS projects;`);
  }
}
