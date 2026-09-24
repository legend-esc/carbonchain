import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `verifiers` table for off-chain persistence of registered
 * verifier addresses and their associated metadata.
 *
 * Schema:
 *  - `address`       VARCHAR(56) PRIMARY KEY — Stellar account address
 *  - `name`          VARCHAR(255) NULLABLE   — optional display name
 *  - `capabilities`  JSONB DEFAULT '[]'      — self-configured service types
 *  - `reputation`    JSONB DEFAULT '{}'      — cached on-chain reputation scores
 *  - `registered_at` TIMESTAMPTZ NOT NULL DEFAULT NOW() — first seen timestamp
 *
 * A unique index on `address` is created explicitly (in addition to the PK
 * constraint) to satisfy `@Index({ unique: true })` in the entity and to
 * support fast lookups by address in `verifier.repository.ts`.
 */
export class CreateVerifiersTable1748476900000 implements MigrationInterface {
  name = 'CreateVerifiersTable1748476900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS verifiers (
        address       VARCHAR(56)  NOT NULL,
        name          VARCHAR(255),
        capabilities  JSONB        NOT NULL DEFAULT '[]',
        reputation    JSONB        NOT NULL DEFAULT '{}',
        registered_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT pk_verifiers PRIMARY KEY (address)
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_verifiers_address
        ON verifiers (address);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_verifiers_address;`);
    await queryRunner.query(`DROP TABLE IF EXISTS verifiers;`);
  }
}
