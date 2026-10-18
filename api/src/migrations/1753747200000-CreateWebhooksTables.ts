import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: CreateWebhooksTables
 *
 * Fixes #911 — moves the webhook registry and delivery queue from the in-memory
 * Map + Redis TTL store to durable Postgres tables so that:
 *   • A pod restart preserves every registered webhook and pending delivery.
 *   • Multiple replicas share one queue via FOR UPDATE SKIP LOCKED.
 *
 * Tables:
 *   webhooks          — registered webhook endpoints (one row per subscription)
 *   webhook_deliveries — delivery outbox; polling loop claims rows with SKIP LOCKED
 *
 * Run:  npx typeorm migration:run   -d src/data-source.ts
 * Undo: npx typeorm migration:revert -d src/data-source.ts
 */
export class CreateWebhooksTables1753747200000 implements MigrationInterface {
  name = 'CreateWebhooksTables1753747200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. webhooks ──────────────────────────────────────────────────────────
    // secret: per-webhook HMAC key generated at registration (#913).
    //         Never returned after the initial registration response.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "webhooks" (
        "id"                  VARCHAR(64)   NOT NULL,
        "url"                 TEXT          NOT NULL,
        "events"              TEXT[]        NOT NULL DEFAULT '{}',
        "active"              BOOLEAN       NOT NULL DEFAULT TRUE,
        "secret"              VARCHAR(128)  NOT NULL,
        "failure_count"       INT           NOT NULL DEFAULT 0,
        "created_at"          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        "last_triggered_at"   TIMESTAMPTZ,
        CONSTRAINT "pk_webhooks" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhooks_active"
        ON "webhooks" ("active");
    `);

    // ── 2. webhook_deliveries ────────────────────────────────────────────────
    // payload_json: full original event body stored at enqueue time (#910).
    //               Retries re-read this column so the body is always identical.
    // next_retry_at: polling condition; indexed so the WHERE clause is fast.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
        "id"              VARCHAR(64)   NOT NULL,
        "webhook_id"      VARCHAR(64)   NOT NULL,
        "event_id"        VARCHAR(64)   NOT NULL DEFAULT 'unknown',
        "event_type"      VARCHAR(128)  NOT NULL,
        "payload_json"    TEXT          NOT NULL,
        "status"          VARCHAR(20)   NOT NULL DEFAULT 'pending',
        "attempts"        INT           NOT NULL DEFAULT 0,
        "last_attempt_at" TIMESTAMPTZ,
        "next_retry_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        "created_at"      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT "pk_webhook_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "fk_webhook_deliveries_webhook"
          FOREIGN KEY ("webhook_id")
          REFERENCES "webhooks" ("id")
          ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_status_next_retry"
        ON "webhook_deliveries" ("status", "next_retry_at")
        WHERE "status" = 'pending';
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook_id"
        ON "webhook_deliveries" ("webhook_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_deliveries";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "webhooks";`);
  }
}
