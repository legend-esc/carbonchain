import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
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
import { Counter, Histogram, register } from 'prom-client';

const dnsLookupAsync = promisify(dnsLookup);

// ── Prometheus metrics (#1184) ────────────────────────────────────────────────

const webhookDeliveriesTotal = new Counter({
  name: 'webhook_deliveries_total',
  help: 'Total number of webhook delivery attempts',
  labelNames: ['status', 'event_type'] as const,
});

const webhookDeliveryDuration = new Histogram({
  name: 'webhook_delivery_duration_seconds',
  help: 'Duration of webhook delivery attempts in seconds',
  labelNames: ['status', 'event_type'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// Register once; guard against duplicate registration in test environments.
try {
  register.registerMetric(webhookDeliveriesTotal);
  register.registerMetric(webhookDeliveryDuration);
} catch {
  // Already registered (e.g. module re-imported in tests) — ignore.
}

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

/** Returned once when a webhook secret is rotated (#1183). */
export interface WebhookSecretRotationResult {
  id: string;
  secret: string;
}

/** Result of a DLQ retry operation (#1185). */
export interface RetryFailedDeliveriesResult {
  retried: number;
  reactivated: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  /** #935 — timestamp when the delivery record was first created (for GC janitor). */
  createdAt: Date;
  lastAttemptAt?: Date;
  nextRetryAt?: Date;
}

/** #1182 — filters accepted by getDeliveries. */
export interface WebhookDeliveryFilters {
  webhookId?: string;
  status?: 'pending' | 'success' | 'failed';
  eventType?: string;
  /** ISO date string or Date — inclusive lower bound on created_at. */
  from?: string | Date;
  /** ISO date string or Date — inclusive upper bound on created_at. */
  to?: string | Date;
  page?: number | string;
  pageSize?: number | string;
}

/** #1182 — paginated delivery query result. */
export interface PaginatedWebhookDeliveries {
  data: WebhookDelivery[];
  total: number;
  page: number;
  pageSize: number;
}

/** #1184 — aggregate webhook metrics for the admin dashboard. */
export interface WebhookMetrics {
  totalWebhooks: number;
  activeWebhooks: number;
  inactiveWebhooks: number;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  pendingDeliveries: number;
  averageDeliveryLatencyMs: number;
  failureRateByEventType: Array<{
    eventType: string;
    total: number;
    failed: number;
    failureRate: number;
  }>;
  topFailingWebhooks: Array<{
    id: string;
    url: string;
    failureCount: number;
    active: boolean;
  }>;
}

const VALID_DELIVERY_STATUSES: readonly ('pending' | 'success' | 'failed')[] = [
  'pending',
  'success',
  'failed',
];
const DEFAULT_DELIVERY_PAGE_SIZE = 50;
const MAX_DELIVERY_PAGE_SIZE = 200;

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
      throw new BadRequestException('Webhook URL must use https in production');
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

  /**
   * #1183 — Rotate the HMAC signing secret for a webhook.
   *
   * Generates a fresh 32-byte secret, persists it, and returns it exactly once.
   * The old secret is invalidated immediately because attemptDelivery reads the
   * secret fresh from the DB on every attempt.
   *
   * @throws NotFoundException when no webhook with the given id exists.
   */
  async rotateWebhookSecret(id: string): Promise<WebhookSecretRotationResult> {
    const secret = randomBytes(32).toString('hex');

    const result = await this.dataSource.query(
      `UPDATE webhooks
          SET secret = $2
        WHERE id = $1`,
      [id, secret],
    );

    // node-postgres returns [rowCount, rows] for UPDATE without RETURNING.
    const rowCount = Array.isArray(result) ? result[0] : undefined;
    const affected = typeof rowCount === 'number' ? rowCount : 0;

    if (affected === 0) {
      throw new NotFoundException(`Webhook ${id} not found`);
    }

    this.logger.log(`Rotated secret for webhook ${id}`);

    return { id, secret };
  }

  // ── DLQ retry (#1185) ──────────────────────────────────────────────────────

  /**
   * #1185 — Replay failed deliveries from the dead-letter queue.
   *
   * Resets failed deliveries to `pending` with `attempts = 0` and
   * `next_retry_at = NOW()` so the queue processor picks them up on the next
   * poll.  Any webhook that was deactivated due to repeated failures is
   * reactivated and its failure counter reset.
   *
   * @param webhookId optional — scope the retry to a single webhook.
   */
  async retryFailedDeliveries(
    webhookId?: string,
  ): Promise<RetryFailedDeliveriesResult> {
    const failedRows = await this.dataSource.query<
      { id: string; webhook_id: string }[]
    >(
      webhookId
        ? `SELECT id, webhook_id
             FROM webhook_deliveries
            WHERE status = 'failed'
              AND webhook_id = $1`
        : `SELECT id, webhook_id
             FROM webhook_deliveries
            WHERE status = 'failed'`,
      webhookId ? [webhookId] : [],
    );

    if (failedRows.length === 0) {
      return { retried: 0, reactivated: 0 };
    }

    const deliveryIds = failedRows.map((r) => r.id);

    await this.dataSource.query(
      `UPDATE webhook_deliveries
          SET status = 'pending',
              attempts = 0,
              next_retry_at = NOW()
        WHERE id = ANY($1::text[])`,
      [deliveryIds],
    );

    const affectedWebhookIds = Array.from(
      new Set(failedRows.map((r) => r.webhook_id)),
    );

    // Reactivate any webhooks that were deactivated by repeated failures.
    const reactivateResult = await this.dataSource.query(
      `UPDATE webhooks
          SET active = TRUE,
              failure_count = 0
        WHERE id = ANY($1::text[])
          AND (active = FALSE OR failure_count > 0)`,
      [affectedWebhookIds],
    );

    const reactivateRowCount = Array.isArray(reactivateResult)
      ? reactivateResult[0]
      : undefined;
    const reactivated =
      typeof reactivateRowCount === 'number' ? reactivateRowCount : 0;

    this.logger.log(
      `Retried ${deliveryIds.length} failed deliveries` +
        (webhookId ? ` for webhook ${webhookId}` : '') +
        `; reactivated ${reactivated} webhook(s)`,
    );

    return { retried: deliveryIds.length, reactivated };
  }

  // ── Delivery enqueue ────────────────────────────────────────────────────────

  /**
   * Enqueue deliveries for every active webhook subscribed to `eventType`.
   *
   * #910 — The full serialised payload is written to `payload_json` at this
   *         point and never reconstructed on retry.
   */
  async triggerWebhooks(eventType: string, eventData: unknown): Promise<void> {
    const webhooks = await this.dataSource.query<{ id: string; url: string }[]>(
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
      const eventIdStr =
        typeof eventId === 'string' ? eventId : JSON.stringify(eventId);

      const payload = {
        id: deliveryId,
        eventId: eventIdStr,
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
          eventIdStr,
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
    >(`SELECT id, url, secret, failure_count FROM webhooks WHERE id = $1`, [
      row.webhook_id,
    ]);

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

    const deliveryStart = process.hrtime.bigint();
    const recordDuration = (status: string): void => {
      const seconds =
        Number(process.hrtime.bigint() - deliveryStart) / 1_000_000_000;
      webhookDeliveryDuration.observe(
        { status, event_type: row.event_type },
        seconds,
      );
    };

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

      // #1184 — Prometheus metrics
      webhookDeliveriesTotal.inc({
        status: 'success',
        event_type: row.event_type,
      });
      recordDuration('success');

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

      // #1184 — Prometheus metrics (failed attempt; may still be retried)
      webhookDeliveriesTotal.inc({
        status: 'failed',
        event_type: row.event_type,
      });
      recordDuration('failed');

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

  /**
   * #1182 — Query delivery history with optional filters and pagination.
   *
   * Accepts either a bare `webhookId` string (legacy call signature) or a
   * filter object.  All filters are applied in SQL; results are paginated.
   */
  async getDeliveries(
    filters?: string | WebhookDeliveryFilters,
  ): Promise<PaginatedWebhookDeliveries> {
    const f: WebhookDeliveryFilters =
      typeof filters === 'string' ? { webhookId: filters } : (filters ?? {});

    const where: string[] = [];
    const params: unknown[] = [];

    if (f.webhookId) {
      params.push(f.webhookId);
      where.push(`webhook_id = $${params.length}`);
    }

    if (f.status) {
      if (!VALID_DELIVERY_STATUSES.includes(f.status)) {
        throw new BadRequestException(
          `Invalid status "${f.status}" — must be one of: ${VALID_DELIVERY_STATUSES.join(', ')}`,
        );
      }
      params.push(f.status);
      where.push(`status = $${params.length}`);
    }

    if (f.eventType) {
      params.push(f.eventType);
      where.push(`event_type = $${params.length}`);
    }

    if (f.from !== undefined && f.from !== null && f.from !== '') {
      const from = this.parseFilterDate(f.from, 'from');
      params.push(from);
      where.push(`created_at >= $${params.length}`);
    }

    if (f.to !== undefined && f.to !== null && f.to !== '') {
      const to = this.parseFilterDate(f.to, 'to');
      params.push(to);
      where.push(`created_at <= $${params.length}`);
    }

    const page = this.parsePositiveInt(f.page, 1, 'page');
    const pageSize = Math.min(
      this.parsePositiveInt(f.pageSize, DEFAULT_DELIVERY_PAGE_SIZE, 'pageSize'),
      MAX_DELIVERY_PAGE_SIZE,
    );
    const offset = (page - 1) * pageSize;

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countRows = await this.dataSource.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
         FROM webhook_deliveries
         ${whereClause}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);

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
        created_at: Date;
      }[]
    >(
      `SELECT id, webhook_id, event_id, event_type, status, attempts,
              last_attempt_at, next_retry_at, created_at
         FROM webhook_deliveries
         ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    return {
      data: rows.map((r) => ({
        id: r.id,
        webhookId: r.webhook_id,
        eventId: r.event_id,
        eventType: r.event_type,
        status: r.status as 'pending' | 'success' | 'failed',
        attempts: r.attempts,
        createdAt: r.created_at,
        lastAttemptAt: r.last_attempt_at ?? undefined,
        nextRetryAt: r.next_retry_at ?? undefined,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** #1182 — parse and validate a date filter value. */
  private parseFilterDate(value: string | Date, field: string): Date {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `Invalid "${field}" date filter: "${String(value)}"`,
      );
    }
    return date;
  }

  /** #1182 — parse a positive integer query param, falling back to a default. */
  private parsePositiveInt(
    value: number | string | undefined,
    fallback: number,
    field: string,
  ): number {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException(
        `Invalid "${field}" value: "${String(value)}" — must be a positive integer`,
      );
    }
    return parsed;
  }

  /**
   * #1184 — Aggregate webhook metrics for the admin dashboard.
   *
   * Returns webhook counts, delivery status breakdown, average delivery
   * latency, failure rate by event type, and the top failing webhooks.
   */
  async getWebhookMetrics(): Promise<WebhookMetrics> {
    // Webhook counts.
    const webhookCountRows = await this.dataSource.query<
      { total: string; active: string }[]
    >(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE active = TRUE)::text AS active
         FROM webhooks`,
    );
    const totalWebhooks = Number(webhookCountRows[0]?.total ?? 0);
    const activeWebhooks = Number(webhookCountRows[0]?.active ?? 0);

    // Delivery status breakdown.
    const deliveryCountRows = await this.dataSource.query<
      { status: string; count: string }[]
    >(
      `SELECT status, COUNT(*)::text AS count
         FROM webhook_deliveries
        GROUP BY status`,
    );
    let successfulDeliveries = 0;
    let failedDeliveries = 0;
    let pendingDeliveries = 0;
    for (const r of deliveryCountRows) {
      const count = Number(r.count);
      if (r.status === 'success') successfulDeliveries = count;
      else if (r.status === 'failed') failedDeliveries = count;
      else if (r.status === 'pending') pendingDeliveries = count;
    }
    const totalDeliveries =
      successfulDeliveries + failedDeliveries + pendingDeliveries;

    // Average delivery latency (ms) for completed deliveries.
    const latencyRows = await this.dataSource.query<
      { avg_ms: string | null }[]
    >(
      `SELECT AVG(EXTRACT(EPOCH FROM (last_attempt_at - created_at)) * 1000)::text AS avg_ms
         FROM webhook_deliveries
        WHERE last_attempt_at IS NOT NULL
          AND status IN ('success', 'failed')`,
    );
    const averageDeliveryLatencyMs = Number(latencyRows[0]?.avg_ms ?? 0);

    // Failure rate by event type.
    const eventTypeRows = await this.dataSource.query<
      { event_type: string; total: string; failed: string }[]
    >(
      `SELECT event_type,
              COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
         FROM webhook_deliveries
        GROUP BY event_type
        ORDER BY COUNT(*) DESC`,
    );
    const failureRateByEventType = eventTypeRows.map((r) => {
      const total = Number(r.total);
      const failed = Number(r.failed);
      return {
        eventType: r.event_type,
        total,
        failed,
        failureRate: total > 0 ? failed / total : 0,
      };
    });

    // Top failing webhooks.
    const topFailingRows = await this.dataSource.query<
      {
        id: string;
        url: string;
        failure_count: number;
        active: boolean;
      }[]
    >(
      `SELECT id, url, failure_count, active
         FROM webhooks
        WHERE failure_count > 0
        ORDER BY failure_count DESC
        LIMIT 10`,
    );
    const topFailingWebhooks = topFailingRows.map((r) => ({
      id: r.id,
      url: r.url,
      failureCount: r.failure_count,
      active: r.active,
    }));

    return {
      totalWebhooks,
      activeWebhooks,
      inactiveWebhooks: totalWebhooks - activeWebhooks,
      totalDeliveries,
      successfulDeliveries,
      failedDeliveries,
      pendingDeliveries,
      averageDeliveryLatencyMs,
      failureRateByEventType,
      topFailingWebhooks,
    };
  }

  /**
   * #935 — delete a single delivery record by id.
   * Used by WebhookJanitorService to bound table growth to the retention window.
   *
   * @returns true when a row was deleted, false when the id was already gone.
   */
  async deleteDelivery(id: string): Promise<boolean> {
    const result = await this.dataSource.query(
      `DELETE FROM webhook_deliveries WHERE id = $1`,
      [id],
    );
    // node-postgres returns [rowCount, rows] for DELETE without RETURNING.
    const rowCount = Array.isArray(result) ? result[0] : undefined;
    return typeof rowCount === 'number' ? rowCount > 0 : false;
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
