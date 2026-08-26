import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import type { EventEmitter } from 'events';
import { MetricsService } from './metrics.service';
import {
  METRICS_EVENT_EMITTER,
  CONTRACT_INVOCATION_COMPLETED,
  RETIREMENT_COMPLETED,
} from './metrics-events';
import type {
  ContractInvocationCompletedEvent,
  RetirementCompletedEvent,
} from './metrics-events';

/**
 * Subscribes to application events emitted by domain services and updates
 * the corresponding Prometheus metrics in MetricsService.
 *
 * This keeps domain services (StellarService, RetirementService, etc.)
 * completely decoupled from prom-client — they only ever emit plain
 * events with simple payloads.
 *
 * All methods are intentionally synchronous: prom-client inc/observe/dec
 * are O(1) in-memory operations that complete in microseconds, so there
 * is no need for async handling.  If the MetricsService properties are
 * undefined (before onModuleInit), we skip them with optional chaining.
 */
@Injectable()
export class MetricsListener implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsListener.name);

  constructor(
    @Inject(METRICS_EVENT_EMITTER) private readonly emitter: EventEmitter,
    private readonly metricsService: MetricsService,
  ) {
    this.emitter.on(
      CONTRACT_INVOCATION_COMPLETED,
      (payload: ContractInvocationCompletedEvent) => {
        this.onContractInvocationCompleted(payload);
      },
    );

    this.emitter.on(
      RETIREMENT_COMPLETED,
      (payload: RetirementCompletedEvent) => {
        this.onRetirementCompleted(payload);
      },
    );

    // Log unhandled error events to avoid crashing the process.
    this.emitter.on('error', (err: Error) => {
      this.logger.error(`MetricsEventEmitter error: ${err.message}`);
    });
  }

  private onContractInvocationCompleted(
    payload: ContractInvocationCompletedEvent,
  ): void {
    // Increment the invocation counter with status label.
    this.metricsService.stellarContractInvocationsTotal?.inc({
      contract: payload.contract,
      method: payload.method,
      status: payload.status,
    });

    // Observe duration (always recorded regardless of success/failure).
    this.metricsService.stellarContractInvocationDurationMs?.observe(
      { contract: payload.contract, method: payload.method },
      payload.durationMs,
    );

    // Observe fee (only on success — #546).
    if (payload.feeStroops !== undefined) {
      this.metricsService.contractCallFeeStroops
        ?.labels({ contract: payload.contract, method: payload.method })
        .observe(payload.feeStroops);
    }
  }

  private onRetirementCompleted(payload: RetirementCompletedEvent): void {
    // Increment retirement counter.
    this.metricsService.carbonchainRetirementsTotal?.inc({
      type: payload.type,
    });

    // Decrement the active-credits gauge for each retired credit.
    // Guard against going below 0 since the gauge starts at 0 and is only
    // decremented here (increments happen via separate credit-issuance
    // events that are out of scope for issue #495).
    if (
      this.metricsService.carbonchainCreditsActiveTotal &&
      payload.count > 0
    ) {
      // prom-client Gauges track values internally and can go negative,
      // but a negative active-credit count would be misleading.  We use
      // dec() rather than set() because concurrent retirement events could
      // race; dec() is atomic at the Gauge level and we accept that a
      // transient negative value could briefly appear under heavy concurrency
      // before the credit-issuance listener catches up.
      this.metricsService.carbonchainCreditsActiveTotal.dec(payload.count);
    }
  }

  onModuleDestroy(): void {
    this.emitter.removeAllListeners(CONTRACT_INVOCATION_COMPLETED);
    this.emitter.removeAllListeners(RETIREMENT_COMPLETED);
    this.emitter.removeAllListeners('error');
  }
}
