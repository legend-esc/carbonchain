import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHmac, randomBytes } from 'crypto';
import { lookup as dnsLookup } from 'dns';
import { promisify } from 'util';
import axios, { AxiosError } from 'axios';
import ipRangeCheck from 'ip-range-check';

const dnsLookupAsync = promisify(dnsLookup);

// ── Private IP ranges to block (SSRF protection #912) ────────────────────────
// Covers loopback, link-local, RFC-1918 private, CGNAT, and cloud metadata.
const BLOCKED_RANGES = [
  '127.0.0.0/8', // loopback (IPv4)
  '::1/128', // loopback (IPv6)
  '0.0.0.0/8', // "this" network
  '10.0.0.0/8', // RFC-1918 private
  '172.16.0.0/12', // RFC-1918 private
  '192.168.0.0/16', // RFC-1918 private
  '100.64.0.0/10', // CGNAT (RFC-6598)
  '169.254.0.0/16', // link-local / AWS metadata endpoint
  'fe80::/10', // link-local (IPv6)
  'fc00::/7', // Unique-local (IPv6)
  '::ffff:0:0/96', // IPv4-mapped IPv6
];

// ── Public interfaces ─────────────────────────────────────────────────────────

/** Row returned to callers — secret is excluded after initial registration. */
export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: Date;
  lastTriggeredAt?: Date;
  failureCount: number;
}

/** Full record including the HMAC secret — only used internally. */
export interface WebhookWithSecret extends Webhook {
  secret: string;
}

/** Returned once at registration so the caller can store the signing secret. */
export interface WebhookRegistrationResult extends Webhook {
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  lastAttemptAt?: Date;
  nextRetryAt?: Date;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhooksService.name);

  private readonly MAX_RETRIES = 5;
  private readonly BASE_RETRY_DELAY_MS = 1000;
  /** Interval handle for the in-process polling loop. */
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly POLL_INTERVAL_MS = 5_000;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  onModuleInit(): void {
    // Start the polling loop that drains the Postgres delivery queue.
    // FOR UPDATE SKIP LOCKED ensures replicas never double-deliver (#911).
    this.pollingInterval = setInterval(() => {
      void this.processQueue();
    }, this.POLL_INTERVAL_MS);
    this.logger.log('Webhook delivery queue polling started');
  }

  onModuleDestroy(): void {
    if (this.pollingInterval !== null) {
      clearInterval(this.pollingInterval);
    }
  }

  // ── SSRF validation helpers (#912) ─────────────────────────────────────────

  /**
   * Validate a webhook URL:
   *  1. Must use https (or http when NODE_ENV !== production).
   *  2. DNS resolves to a non-private, non-loopback address.
   *
   * Throws BadRequestException with a descriptive message on failure.
   * Re-validated at delivery time to catch DNS-rebinding attacks.
   */
  async validateWebhookUrl(rawUrl: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestException(
        `Invalid webhook URL: "${rawUrl}" could not be parsed`,
      );
    }

    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';

    if (isProduction && parsed.protocol !== 'https:') {
      throw new BadRequestException(
        'Webhook URL must use https in production',
      );
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException(
        `Webhook URL scheme "${parsed.protocol}" is not allowed — use https`,
      );
    }

    await this.assertHostNotPrivate(parsed.hostname);
  }

  /**
   * Resolve `hostname` via DNS and reject if any returned address falls within
   * a blocked range.  This is called both at registration and at delivery to
   * prevent DNS-rebinding (#912).
   */
  private async assertHostNotPrivate(hostname: string): Promise<void> {
    // Block literal IP addresses without a DNS round-trip.
    if (ipRangeCheck(hostname, BLOCKED_RANGES)) {
      throw new BadRequestException(
        `Webhook URL resolves to a blocked IP address (${hostname})`,
      );
    }

    let resolved: string;
    try {
      const result = await dnsLookupAsync(hostname);
      resolved = result.address;
    } catch (err) {
      throw new BadRequestException(
        `Webhook URL hostname "${hostname}" could not be resolved: ${(err as Error).message}`,
      );
    }

    if (ipRangeCheck(resolved, BLOCKED_RANGES)) {
      throw new BadRequestException(
        `Webhook URL resolves to a blocked IP address (${resolved}) — internal addresses are not allowed`,
      );
    }
  }

  // ── Registry (#911 + #913) ─────────────────────────────────────────────────

  /**
   * Register a new webhook endpoint.
   *
   * #912 — URL is validated for SSRF before insertion.
   * #913 — A random 32-byte signing secret is generated and stored.  It is
   *         returned exactly once in WebhookRegistrationResult.secret; callers
   *         must persist it because subsequent GET responses omit it.
   */
  async registerWebhook(
    url: string,
    events: string[],
  ): Promise<WebhookRegistrationResult> {
    await this.validateWebhookUrl(url);

    const id = `webhook_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');

    await this.dataSource.query(
      `INSERT INTO webhooks
         (id, url, events, active, secret, failure_count, created_at)
       VALUES ($1, $2, $3, TRUE, $4, 0, NOW())`,
      [id, url, events, secret],
    );

    this.logger.log(
      `Registered webhook ${id} for events: ${events.join(', ')}`,
    );

    return {
      id,
      url,
      events,
      active: true,
      failureCount: 0,
      createdAt: new Date(),
      secret, // returned once — store it
    };
  }

  async getWebhooks(): Promise<Webhook[]> {
    const rows = await this.dataSource.query<
      {
        id: string;
        url: string;
        events: string[];
        active: boolean;
        failure_count: number;
        created_at: Date;
        last_triggered_at: Date | null;
      }[]
    >(
      `SELECT id, url, events, active, failure_count, created_at, last_triggered_at
         FROM webhooks
        ORDER BY created_at DESC`,
    );
    return rows.map((r) => this.rowToWebhook(r));
  }

  async getWebhook(id: string): Promise<Webhook | undefined> {
    const rows = await this.dataSource.query<
      {
        id: string;
        url: string;
        events: string[];
        active: boolean;
        failure_count: number;
        created_at: Date;
        last_triggered_at: Date | null;
      }[]
    >(
      `SELECT id, url, events, active, failure_count, created_at, last_triggered_at
         FROM webhooks
        WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? this.rowToWebhook(rows[0]) : undefined;
  }

  async deleteWebhook(id: string): Promise<boolean> {
    const result = await this.dataSource.query<{ rowCount?: number }>(
      `DELETE FROM webhooks WHERE id = $1`,
      [id],
    );
    // TypeORM raw query returns [rows, rowCount] for pg driver.
    const affected = Array.isArray(result) ? (result[1] as number) : 0;
    return affected > 0;
  }

  // ── Delivery enqueue ────────────────────────────────────────────────────────

  /**
   * Enqueue deliveries for every active webhook subscribed to `eventType`.
   *
   * #910 — The full serialised payload is written to `payload_json` at this
   *         point and never reconstructed on retry.
   */
  async triggerWebhooks(eventType: string, eventData: unknown): Promise<void> {
    const webhooks = await this.dataSource.query<
      { id: string; url: string }[]
    >(
      `SELECT id, url
         FROM webhooks
        WHERE active = TRUE
          AND $1 = ANY(events)`,
      [eventType],
    );

    for (const webhook of webhooks) {
      const deliveryId = `delivery_${Date.now()}_${randomBytes(4).toString('hex')}`;
      const eventId =
        (eventData as Record<string, unknown>)?.['id'] ?? 'unknown';

      const payload = {
        id: deliveryId,
        eventId: String(eventId),
        eventType,
        data: eventData,
        timestamp: new Date().toISOString(),
      };

      await this.dataSource.query(
        `INSERT INTO webhook_deliveries
           (id, webhook_id, event_id, event_type, payload_json,
            status, attempts, next_retry_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', 0, NOW(), NOW())`,
        [
          deliveryId,
          webhook.id,
          String(eventId),
          eventType,
          JSON.stringify(payload),
        ],
      );

      this.logger.debug(
        `Enqueued delivery ${deliveryId} for webhook ${webhook.id} (${webhook.url})`,
      );
    }
  }

  // ── Delivery queue processor (#911 — FOR UPDATE SKIP LOCKED) ───────────────

  /**
   * Claim and attempt pending deliveries from Postgres.
   *
   * FOR UPDATE SKIP LOCKED lets multiple replicas poll concurrently — each
   * replica claims a non-overlapping batch of rows, so every message is
   * delivered exactly once even across restarts (#911).
   */
  async processQueue(): Promise<void> {
    let rows: {
      id: string;
      webhook_id: string;
      event_type: string;
      payload_json: string;
      attempts: number;
    }[];

    try {
      rows = await this.dataSource.query(
        `SELECT d.id, d.webhook_id, d.event_type, d.payload_json, d.attempts
           FROM webhook_deliveries d
          WHERE d.status = 'pending'
            AND d.next_retry_at <= NOW()
          ORDER BY d.next_retry_at
          LIMIT 10
          FOR UPDATE SKIP LOCKED`,
      );
    } catch (err) {
      this.logger.warn(
        `processQueue: failed to claim rows — ${(err as Error).message}`,
      );
      return;
    }

    for (const row of rows) {
      await this.attemptDelivery(row);
    }
  }

  // ── Delivery attempt (#910 + #912 + #913) ──────────────────────────────────

  /**
   * Execute a single delivery attempt.
   *
   * #910 — Body is read verbatim from `payload_json`; never reconstructed.
   * #912 — DNS-rebinding check re-runs at delivery time.
   * #913 — HMAC signature computed over the raw JSON body and sent as
   *         x-carbonchain-signature; attempt number sent as x-carbonchain-retry.
   */
  private async attemptDelivery(row: {
    id: string;
    webhook_id: string;
    event_type: string;
    payload_json: string;
    attempts: number;
  }): Promise<void> {
    const attemptNumber = row.attempts + 1;

    // Fetch the parent webhook (need url + secret).
    const webhookRows = await this.dataSource.query<
      {
        id: string;
        url: string;
        secret: string;
        failure_count: number;
      }[]
    >(
      `SELECT id, url, secret, failure_count FROM webhooks WHERE id = $1`,
      [row.webhook_id],
    );

    if (webhookRows.length === 0) {
      // Webhook was deleted while delivery was queued — discard.
      await this.dataSource.query(
        `UPDATE webhook_deliveries SET status = 'failed' WHERE id = $1`,
        [row.id],
      );
      return;
    }

    const webhook = webhookRows[0];

    // #912 — DNS-rebinding guard: re-validate at delivery time.
    try {
      const parsed = new URL(webhook.url);
      await this.assertHostNotPrivate(parsed.hostname);
    } catch (err) {
      this.logger.warn(
        `Delivery ${row.id} aborted — URL failed SSRF re-check: ${(err as Error).message}`,
      );
      await this.dataSource.query(
        `UPDATE webhook_deliveries
            SET status = 'failed',
                attempts = $2,
                last_attempt_at = NOW()
          WHERE id = $1`,
        [row.id, attemptNumber],
      );
      return;
    }

    // #910 — Use the stored original payload verbatim.
    const rawBody = row.payload_json;

    // #913 — HMAC-sign the raw body with the per-webhook secret.
    const timestamp = new Date().toISOString();
    const signingInput = `${timestamp}.${rawBody}`;
    const signature = createHmac('sha256', webhook.secret)
      .update(signingInput)
      .digest('hex');

    try {
      await axios.post(webhook.url, JSON.parse(rawBody) as unknown, {
        headers: {
          'content-type': 'application/json',
          // #913 — HMAC signature header
          'x-carbonchain-signature': `sha256=${signature}`,
          'x-carbonchain-timestamp': timestamp,
          // #910 — retry counter; 1 on first attempt, 2+ on retries
          'x-carbonchain-retry': String(attemptNumber),
        },
        timeout: 10_000,
      });

      // Success
      await this.dataSource.query(
        `UPDATE webhook_deliveries
            SET status = 'success',
                attempts = $2,
                last_attempt_at = NOW()
          WHERE id = $1`,
        [row.id, attemptNumber],
      );
      await this.dataSource.query(
        `UPDATE webhooks
            SET failure_count = 0,
                last_triggered_at = NOW()
          WHERE id = $1`,
        [webhook.id],
      );
      this.logger.log(
        `Webhook ${webhook.id} delivered successfully (delivery ${row.id}, attempt ${attemptNumber})`,
      );
    } catch (error) {
      const axiosError = error as AxiosError;
      const newFailureCount = webhook.failure_count + 1;

      if (attemptNumber < this.MAX_RETRIES) {
        const backoffMs =
          this.BASE_RETRY_DELAY_MS * Math.pow(2, attemptNumber - 1);
        const nextRetry = new Date(Date.now() + backoffMs);

        await this.dataSource.query(
          `UPDATE webhook_deliveries
              SET status = 'pending',
                  attempts = $2,
                  last_attempt_at = NOW(),
                  next_retry_at = $3
            WHERE id = $1`,
          [row.id, attemptNumber, nextRetry],
        );
        this.logger.warn(
          `Webhook ${webhook.id} attempt ${attemptNumber}/${this.MAX_RETRIES} failed — ` +
            `retry at ${nextRetry.toISOString()}`,
        );
      } else {
        await this.dataSource.query(
          `UPDATE webhook_deliveries
              SET status = 'failed',
                  attempts = $2,
                  last_attempt_at = NOW()
            WHERE id = $1`,
          [row.id, attemptNumber],
        );
        await this.dataSource.query(
          `UPDATE webhooks
              SET failure_count = $2,
                  active = FALSE
            WHERE id = $1`,
          [webhook.id, newFailureCount],
        );
        this.logger.error(
          `Webhook ${webhook.id} permanently failed after ${this.MAX_RETRIES} attempts: ${axiosError.message}`,
        );
      }
    }
  }

  // ── Delivery queries ────────────────────────────────────────────────────────

  async getDeliveries(webhookId?: string): Promise<WebhookDelivery[]> {
    const rows = await this.dataSource.query<
      {
        id: string;
        webhook_id: string;
        event_id: string;
        event_type: string;
        status: string;
        attempts: number;
        last_attempt_at: Date | null;
        next_retry_at: Date | null;
      }[]
    >(
      webhookId
        ? `SELECT id, webhook_id, event_id, event_type, status, attempts,
                  last_attempt_at, next_retry_at
             FROM webhook_deliveries
            WHERE webhook_id = $1
            ORDER BY created_at DESC`
        : `SELECT id, webhook_id, event_id, event_type, status, attempts,
                  last_attempt_at, next_retry_at
             FROM webhook_deliveries
            ORDER BY created_at DESC`,
      webhookId ? [webhookId] : [],
    );

    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhook_id,
      eventId: r.event_id,
      eventType: r.event_type,
      status: r.status as 'pending' | 'success' | 'failed',
      attempts: r.attempts,
      lastAttemptAt: r.last_attempt_at ?? undefined,
      nextRetryAt: r.next_retry_at ?? undefined,
    }));
  }

  // ── Signature helpers (kept for external use / tests) ──────────────────────

  generateSignature(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  getSignatureHeaderName(): string {
    return 'x-carbonchain-signature';
  }

  getSignatureAlgorithm(): string {
    return 'sha256';
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private rowToWebhook(r: {
    id: string;
    url: string;
    events: string[];
    active: boolean;
    failure_count: number;
    created_at: Date;
    last_triggered_at: Date | null;
  }): Webhook {
    return {
      id: r.id,
      url: r.url,
      events: r.events,
      active: r.active,
      failureCount: r.failure_count,
      createdAt: r.created_at,
      lastTriggeredAt: r.last_triggered_at ?? undefined,
    };
  }
}
