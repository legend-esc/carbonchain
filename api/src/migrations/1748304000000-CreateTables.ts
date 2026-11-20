import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateTables
 *
 * Creates the initial schema for CarbonChain's off-chain index.
 *
 * Tables created (in dependency order):
 *   1. verifiers       — registered verifier nodes
 *   2. projects        — registered project profiles
 *   3. credits         — off-chain index of on-chain carbon credits
 *   4. retirements     — off-chain index of on-chain retirement records
 *
 * All FK constraints and indexes are explicit — TypeORM sync is disabled.
 *
 * Run:  npx typeorm migration:run   -d src/data-source.ts
 * Undo: npx typeorm migration:revert -d src/data-source.ts
 */
export class CreateTables1748304000000 implements MigrationInterface {
  name = 'CreateTables1748304000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. verifiers ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "verifiers" (
        "address"     VARCHAR(64)  NOT NULL,
        "created_at"  BIGINT       NOT NULL DEFAULT 0,
        CONSTRAINT "pk_verifiers" PRIMARY KEY ("address")
      );
    `);

    // ── 2. projects ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "projects" (
        "id"            VARCHAR(64)   NOT NULL,
        "name"          VARCHAR(255)  NOT NULL,
        "developer"     VARCHAR(255)  NOT NULL DEFAULT '',
        "description"   TEXT          NOT NULL DEFAULT '',
        "location"      VARCHAR(255)  NOT NULL DEFAULT '',
        "methodology"   VARCHAR(50)   NOT NULL,
        "documents_cid" VARCHAR(255)  NOT NULL DEFAULT '',
        "created_at"    BIGINT        NOT NULL DEFAULT 0,
        CONSTRAINT "pk_projects" PRIMARY KEY ("id")
      );
    `);

    // Index: look up projects by methodology (common marketplace filter)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_projects_methodology"
        ON "projects" ("methodology");
    `);

    // ── 3. credits ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "credits" (
        "id"           VARCHAR(64)   NOT NULL,
        "project_id"   VARCHAR(64)   NOT NULL,
        "issuer"       VARCHAR(64)   NOT NULL,
        "owner"        VARCHAR(64)   NOT NULL,
        "vintage_year" INT           NOT NULL,
        "methodology"  VARCHAR(50)   NOT NULL,
        "geography"    VARCHAR(10)   NOT NULL,
        "tonnes"       VARCHAR(40)   NOT NULL,
        "ipfs_hash"    VARCHAR(255)  NOT NULL DEFAULT '',
        "status"       VARCHAR(20)   NOT NULL DEFAULT 'Pending',
        "issued_at"    BIGINT        NOT NULL DEFAULT 0,
        CONSTRAINT "pk_credits" PRIMARY KEY ("id")
      );
    `);

    // Composite index: most common marketplace filter (status + methodology + geography)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_credits_status_methodology_geography"
        ON "credits" ("status", "methodology", "geography");
    `);

    // Index: vintage year range queries
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_credits_vintage_year"
        ON "credits" ("vintage_year");
    `);

    // Index: owner/issuer lookups (portfolio queries)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_credits_owner_address"
        ON "credits" ("issuer");
    `);

    // Index: project → credits join
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_credits_project_id"
        ON "credits" ("project_id");
    `);

    // ── 4. retirements ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "retirements" (
        "id"             VARCHAR(64)   NOT NULL,
        "credit_id"      VARCHAR(64)   NOT NULL,
        "buyer"          VARCHAR(64)   NOT NULL,
        "tonnes_retired" VARCHAR(40)   NOT NULL,
        "reason"         TEXT          NOT NULL DEFAULT '',
        "retired_at"     BIGINT        NOT NULL DEFAULT 0,
        "tx_hash"        VARCHAR(255)  NOT NULL DEFAULT '',
        CONSTRAINT "pk_retirements" PRIMARY KEY ("id"),
        CONSTRAINT "fk_retirements_credit"
          FOREIGN KEY ("credit_id")
          REFERENCES "credits" ("id")
          ON DELETE CASCADE
      );
    `);

    // Index: look up retirements by buyer account
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_retirements_buyer"
        ON "retirements" ("buyer");
    `);

    // Index: chronological retirement queries
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_retirements_retired_at"
        ON "retirements" ("retired_at");
    `);

    // Index: credit → retirements join
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_retirements_credit_id"
        ON "retirements" ("credit_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse dependency order to satisfy FK constraints
    await queryRunner.query(`DROP TABLE IF EXISTS "retirements";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "credits";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "projects";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "verifiers";`);
  }
}
