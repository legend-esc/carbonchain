import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Backs webhooks.service.ts persistence (issue: webhooks Maps loaded from
 * CacheService are a possible no-op / not durable across restarts or pods).
 */
export class CreateWebhooksTables1756000000000 implements MigrationInterface {
  name = 'CreateWebhooksTables1756000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'webhooks',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'url', type: 'varchar' },
          { name: 'events', type: 'text', isArray: true },
          { name: 'active', type: 'boolean', default: true },
          {
            name: 'createdAt',
            type: 'timestamptz',
            default: 'now()',
          },
          { name: 'lastTriggeredAt', type: 'timestamptz', isNullable: true },
          { name: 'failureCount', type: 'int', default: 0 },
        ],
      }),
      true,
    );

    await queryRunner.createTable(
      new Table({
        name: 'webhook_deliveries',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'webhookId', type: 'uuid' },
          { name: 'eventId', type: 'varchar' },
          { name: 'status', type: 'varchar', default: "'pending'" },
          { name: 'attempts', type: 'int', default: 0 },
          { name: 'lastAttemptAt', type: 'timestamptz', isNullable: true },
          { name: 'nextRetryAt', type: 'timestamptz', isNullable: true },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('webhook_deliveries');
    await queryRunner.dropTable('webhooks');
  }
}
