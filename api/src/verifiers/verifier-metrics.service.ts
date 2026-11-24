/**
 * #1305 — VerifierMetricsService
 *
 * Calculates SLA and approval turnaround metrics for a verifier address.
 *
 * Metrics returned:
 *   average_turnaround_hours  — mean hours from CreditSubmitted → CreditApproved/Rejected
 *   approval_rate             — approved / (approved + rejected), range [0, 1]
 *   total_tonnes_reviewed     — sum of tonnes for all credits reviewed
 *   total_reviewed            — total credits where a final decision was recorded
 *
 * Data source: EventEntity rows with event_type = 'CreditSubmitted' and
 * 'CreditApproved' / 'CreditRejected', correlated by credit_id inside the
 * event data payload.
 *
 * Cache TTL: 10 minutes (600 s).
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEntity } from '../events/event.entity';
import { CacheService } from '../common/cache.service';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VerifierMetrics {
  address: string;
  average_turnaround_hours: number;
  approval_rate: number;
  total_tonnes_reviewed: string;
  total_reviewed: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS = 600; // 10 minutes

const SUBMITTED_EVENT = 'CreditSubmitted';
const APPROVED_EVENT = 'CreditApproved';
const REJECTED_EVENT = 'CreditRejected';

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class VerifierMetricsService {
  private readonly logger = new Logger(VerifierMetricsService.name);

  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepo: Repository<EventEntity>,
    private readonly cacheService: CacheService,
  ) {}

  /**
   * Returns SLA and approval metrics for the verifier at `address`.
   *
   * Cache key: `verifier-metrics:<address>`
   * TTL: 10 minutes.
   */
  async getMetrics(address: string): Promise<VerifierMetrics> {
    const cacheKey = `verifier-metrics:${address}`;
    const cached = await this.cacheService.get<VerifierMetrics>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache HIT for verifier metrics ${address}`);
      return cached;
    }

    const metrics = await this.computeMetrics(address);

    await this.cacheService.set(cacheKey, metrics, CACHE_TTL_SECONDS);
    return metrics;
  }

  // ── Computation ────────────────────────────────────────────────────────────

  private async computeMetrics(address: string): Promise<VerifierMetrics> {
    // Load all events relevant to this verifier.
    // The event data payload is expected to contain:
    //   { credit_id, verifier, tonnes } for submit events
    //   { credit_id, verifier }         for approve/reject events
    let events: EventEntity[];
    try {
      events = await this.eventRepo
        .createQueryBuilder('e')
        .where('e.eventType IN (:...types)', {
          types: [SUBMITTED_EVENT, APPROVED_EVENT, REJECTED_EVENT],
        })
        .orderBy('e.timestamp', 'ASC')
        .getMany();
    } catch (err) {
      this.logger.error(
        `Failed to load verifier events for ${address}: ${(err as Error).message}`,
      );
      return this.emptyMetrics(address);
    }

    // Partition events by credit_id.
    const submitMap = new Map<string, EventEntity>();   // creditId → submitted event
    const decisionMap = new Map<string, EventEntity>(); // creditId → approved/rejected event

    for (const ev of events) {
      const payload = ev.data as Record<string, unknown>;
      const creditId =
        typeof payload['credit_id'] === 'string' ? payload['credit_id'] : null;
      const verifier =
        typeof payload['verifier'] === 'string' ? payload['verifier'] : null;

      if (!creditId) continue;

      if (ev.eventType === SUBMITTED_EVENT) {
        // Submitted events are not filtered by verifier — the submission
        // represents a credit entering the review queue globally.
        if (!submitMap.has(creditId)) {
          submitMap.set(creditId, ev);
        }
      } else if (
        ev.eventType === APPROVED_EVENT ||
        ev.eventType === REJECTED_EVENT
      ) {
        // Only count decisions made by this specific verifier.
        if (verifier === address && !decisionMap.has(creditId)) {
          decisionMap.set(creditId, ev);
        }
      }
    }

    // Compute turnaround times and totals.
    let totalTurnaroundSeconds = 0;
    let approvedCount = 0;
    let rejectedCount = 0;
    let totalTonnesBigInt = 0n;

    for (const [creditId, decisionEvent] of decisionMap.entries()) {
      const submitEvent = submitMap.get(creditId);

      if (submitEvent) {
        const deltaSeconds = Number(decisionEvent.timestamp) - Number(submitEvent.timestamp);
        // Clamp negative deltas (clock skew / data issues) to zero.
        totalTurnaroundSeconds += Math.max(0, deltaSeconds);
      }

      if (decisionEvent.eventType === APPROVED_EVENT) {
        approvedCount++;
      } else {
        rejectedCount++;
      }

      // Accumulate tonnes from the submission event payload when available.
      const submitPayload = submitEvent?.data as Record<string, unknown> | undefined;
      const rawTonnes = submitPayload?.['tonnes'];
      if (rawTonnes !== undefined) {
        try {
          totalTonnesBigInt += BigInt(String(rawTonnes));
        } catch {
          // Non-parseable tonnes — skip.
        }
      }
    }

    const totalReviewed = approvedCount + rejectedCount;
    const averageTurnaroundHours =
      totalReviewed > 0
        ? totalTurnaroundSeconds / totalReviewed / 3600
        : 0;

    const approvalRate =
      totalReviewed > 0 ? approvedCount / totalReviewed : 0;

    return {
      address,
      average_turnaround_hours: Math.round(averageTurnaroundHours * 100) / 100,
      approval_rate: Math.round(approvalRate * 10000) / 10000,
      total_tonnes_reviewed: totalTonnesBigInt.toString(),
      total_reviewed: totalReviewed,
    };
  }

  private emptyMetrics(address: string): VerifierMetrics {
    return {
      address,
      average_turnaround_hours: 0,
      approval_rate: 0,
      total_tonnes_reviewed: '0',
      total_reviewed: 0,
    };
  }
}
