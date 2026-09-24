import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateEventsTable1753574400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'events',
        columns: [
          {
            name: 'id',
            type: 'varchar',
            length: '255',
            isPrimary: true,
          },
          {
            name: 'contract_id',
            type: 'varchar',
            length: '100',
          },
          {
            name: 'event_type',
            type: 'varchar',
            length: '100',
          },
          {
            name: 'ledger',
            type: 'bigint',
          },
          {
            name: 'tx_hash',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          {
            name: 'timestamp',
            type: 'bigint',
          },
          {
            name: 'data',
            type: 'jsonb',
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

    // Create indexes for efficient querying
    await queryRunner.createIndex(
      'events',
      new TableIndex({
        name: 'IDX_events_contract_id',
        columnNames: ['contract_id'],
      }),
    );

    await queryRunner.createIndex(
      'events',
      new TableIndex({
        name: 'IDX_events_event_type',
        columnNames: ['event_type'],
      }),
    );

    await queryRunner.createIndex(
      'events',
      new TableIndex({
        name: 'IDX_events_ledger',
        columnNames: ['ledger'],
      }),
    );

    await queryRunner.createIndex(
      'events',
      new TableIndex({
        name: 'IDX_events_contract_id_ledger',
        columnNames: ['contract_id', 'ledger'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('events');
  }
}
