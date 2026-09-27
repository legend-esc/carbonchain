import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Migration: CreateAdminAuditTable
 * Issue #934 — immutable audit row per admin mutation.
 */
export class CreateAdminAuditTable1753747200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'admin_audit',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'actor',
            type: 'varchar',
            length: '100',
          },
          {
            name: 'action',
            type: 'varchar',
            length: '100',
          },
          {
            name: 'target',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'before_state',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'after_state',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'ip_address',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          {
            name: 'user_agent',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'request_id',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'admin_audit',
      new TableIndex({
        name: 'IDX_admin_audit_actor',
        columnNames: ['actor'],
      }),
    );

    await queryRunner.createIndex(
      'admin_audit',
      new TableIndex({
        name: 'IDX_admin_audit_action',
        columnNames: ['action'],
      }),
    );

    await queryRunner.createIndex(
      'admin_audit',
      new TableIndex({
        name: 'IDX_admin_audit_created_at',
        columnNames: ['created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('admin_audit');
  }
}
