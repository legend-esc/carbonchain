import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOffChainIndexTables1748563200000 implements MigrationInterface {
  name = 'CreateOffChainIndexTables1748563200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS credits (
        id varchar PRIMARY KEY, project_id varchar NOT NULL, issuer varchar NOT NULL,
        owner varchar NOT NULL, vintage_year integer NOT NULL, methodology varchar NOT NULL,
        geography varchar NOT NULL, tonnes varchar NOT NULL, ipfs_hash varchar NOT NULL,
        status varchar NOT NULL, issued_at bigint NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS retirements (
        id varchar PRIMARY KEY, credit_id varchar NOT NULL, buyer varchar NOT NULL,
        tonnes_retired varchar NOT NULL, reason varchar NOT NULL, retired_at bigint NOT NULL,
        tx_hash varchar NOT NULL DEFAULT ''
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id varchar PRIMARY KEY, name varchar NOT NULL, developer varchar NOT NULL,
        description varchar NOT NULL, location varchar NOT NULL, methodology varchar NOT NULL,
        documents_cid varchar NOT NULL DEFAULT ''
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS projects');
    await queryRunner.query('DROP TABLE IF EXISTS retirements');
    await queryRunner.query('DROP TABLE IF EXISTS credits');
  }
}