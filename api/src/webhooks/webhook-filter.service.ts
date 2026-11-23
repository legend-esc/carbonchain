/**
 * #1307 — Webhook endpoint event filtering by project methodology and volume threshold.
 *
 * Evaluates a webhook's optional `filter_criteria` JSON before an event is
 * enqueued for delivery.  Events that do not match every configured criterion
 * are silently skipped (not enqueued).  When `filter_criteria` is empty / null
 * the webhook receives all events (default-allow behaviour).
 *
 * Supported criteria fields:
 *   - `methodologies`: string[]  — event's methodology must be in this list.
 *   - `min_tonnes`: number       — event's tonnes_retired / tonnes must be ≥ this value.
 *   - `event_types`: string[]    — event type must be in this list.
 */
import { Injectable, Logger } from '@nestjs/common';

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Persisted as a JSON column on the webhooks table.
 * All fields are optional — omitting a field means "no restriction on that dimension".
 */
export interface WebhookFilterCriteria {
  /** Allow only events whose `methodology` matches one of these values. */
  methodologies?: string[];
  /** Allow only events whose `tonnes_retired` or `tonnes` field is ≥ this value. */
  min_tonnes?: number;
  /** Allow only these event type strings (e.g. 'credit.retired', 'offer.created'). */
  event_types?: string[];
}

/** Minimal payload shape inspected by the filter. All fields are optional. */
export interface FilterableEventPayload {
  methodology?: string;
  tonnes_retired?: string | number;
  tonnes?: string | number;
  [key: string]: unknown;
}

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class WebhookFilterService {
  private readonly logger = new Logger(WebhookFilterService.name);

  /**
   * Determine whether `eventType` with `payload` should be delivered to a
   * webhook configured with `criteria`.
   *
   * @returns `true`  — event passes all criteria and should be enqueued.
   * @returns `false` — event is filtered out; delivery must be skipped.
   */
  shouldDeliver(
    eventType: string,
    payload: FilterableEventPayload,
    criteria: WebhookFilterCriteria | null | undefined,
  ): boolean {
    // No criteria configured → deliver all events (default-allow).
    if (!criteria || Object.keys(criteria).length === 0) {
      return true;
    }

    // ── event_types filter ──────────────────────────────────────────────────
    if (
      criteria.event_types &&
      criteria.event_types.length > 0 &&
      !criteria.event_types.includes(eventType)
    ) {
      this.logger.debug(
        `Event "${eventType}" filtered out — not in event_types: [${criteria.event_types.join(', ')}]`,
      );
      return false;
    }

    // ── methodologies filter ────────────────────────────────────────────────
    if (criteria.methodologies && criteria.methodologies.length > 0) {
      const eventMethodology = payload.methodology ?? '';
      if (!criteria.methodologies.includes(eventMethodology)) {
        this.logger.debug(
          `Event "${eventType}" filtered out — methodology "${eventMethodology}" not in ` +
            `[${criteria.methodologies.join(', ')}]`,
        );
        return false;
      }
    }

    // ── min_tonnes filter ───────────────────────────────────────────────────
    if (criteria.min_tonnes !== undefined && criteria.min_tonnes > 0) {
      // Accept either `tonnes_retired` (retirement events) or `tonnes` (offer events).
      const rawTonnes = payload.tonnes_retired ?? payload.tonnes;
      const eventTonnes =
        rawTonnes !== undefined ? Number(rawTonnes) : undefined;

      if (eventTonnes === undefined || isNaN(eventTonnes)) {
        // Event carries no tonnage field — cannot satisfy min_tonnes → skip.
        this.logger.debug(
          `Event "${eventType}" filtered out — no tonnage field found and min_tonnes=${criteria.min_tonnes} is set`,
        );
        return false;
      }

      if (eventTonnes < criteria.min_tonnes) {
        this.logger.debug(
          `Event "${eventType}" filtered out — tonnes ${eventTonnes} < min_tonnes ${criteria.min_tonnes}`,
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Parse a raw JSON value from the database into a `WebhookFilterCriteria`
   * object.  Returns `null` when the value is absent or malformed.
   */
  parseCriteria(raw: unknown): WebhookFilterCriteria | null {
    if (raw === null || raw === undefined) return null;

    let parsed: unknown;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.logger.warn(`Failed to parse webhook filter_criteria JSON: "${raw}"`);
        return null;
      }
    } else {
      parsed = raw;
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const criteria: WebhookFilterCriteria = {};

    if (Array.isArray(obj['methodologies'])) {
      criteria.methodologies = (obj['methodologies'] as unknown[])
        .filter((v) => typeof v === 'string') as string[];
    }

    if (typeof obj['min_tonnes'] === 'number') {
      criteria.min_tonnes = obj['min_tonnes'];
    }

    if (Array.isArray(obj['event_types'])) {
      criteria.event_types = (obj['event_types'] as unknown[])
        .filter((v) => typeof v === 'string') as string[];
    }

    return criteria;
  }
}
