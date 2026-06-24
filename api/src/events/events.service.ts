import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { rpc } from '@stellar/stellar-sdk';
import { CacheService } from '../common/cache.service';

export interface SorobanEvent {
  id: string;
  type: string;
  contractId: string;
  ledger: number;
  timestamp: number;
  data: Record<string, unknown>;
}

/** Event types that indicate a credit status change — invalidate cache on these. */
const CREDIT_STATUS_CHANGE_EVENTS = new Set([
  'CreditMinted',
  'CreditRetired',
  'CreditFlagged',
  'CreditRevoked',
]);

@Injectable()
export class EventsService implements OnModuleInit {
  private readonly logger = new Logger(EventsService.name);
  private lastLedger = 0;
  private events: Map<string, SorobanEvent> = new Map();

  constructor(
    private stellarService: StellarService,
    private configService: ConfigService,
    private webhooksService: WebhooksService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit() {
    this.logger.log('EventsService initialized');
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async indexEvents(): Promise<void> {
    try {
      const contractIds = [
        this.configService.get<string>('CREDIT_REGISTRY_CONTRACT_ID'),
        this.configService.get<string>('RETIREMENT_CONTRACT_ID'),
        this.configService.get<string>('MARKETPLACE_CONTRACT_ID'),
        this.configService.get<string>('MRV_ORACLE_CONTRACT_ID'),
      ].filter((id): id is string => Boolean(id));

      for (const contractId of contractIds) {
        await this.indexContractEvents(contractId);
      }

      // Retry failed webhook deliveries
      await this.webhooksService.retryFailedDeliveries();
    } catch (error) {
      this.logger.error(`Failed to index events: ${(error as Error).message}`);
    }
  }

  private async indexContractEvents(contractId: string): Promise<void> {
    try {
      const events = await this.stellarService.getContractEvents(
        contractId,
        this.lastLedger,
      );

      for (const event of events) {
        const eventId = `${contractId}-${event.ledger}-${event.id}`;
        const sorobanEvent: SorobanEvent = {
          id: eventId,
          type: this.parseEventType(event),
          contractId,
          ledger: event.ledger,
          timestamp: this.parseEventTimestamp(event),
          data: this.parseEventData(event),
        };

        this.events.set(eventId, sorobanEvent);
        this.logger.debug(
          `Indexed event: ${sorobanEvent.type} from contract ${contractId}`,
        );

        // Invalidate credit cache on status-change events
        if (CREDIT_STATUS_CHANGE_EVENTS.has(sorobanEvent.type)) {
          const creditId = sorobanEvent.data['credit_id'] as string | undefined;
          if (creditId) {
            await this.cache.del(`credits:${creditId}`);
          }
          await this.cache.delPattern('credits:list:*');
          this.logger.debug(
            `Cache invalidated after event: ${sorobanEvent.type}`,
          );
        }

        // Trigger webhooks for this event
        await this.webhooksService.triggerWebhooks(
          sorobanEvent.type,
          sorobanEvent,
        );
      }

      if (events.length > 0) {
        this.lastLedger = Math.max(...events.map((e) => e.ledger));
      }
    } catch (error) {
      this.logger.error(
        `Failed to index events for contract ${contractId}: ${(error as Error).message}`,
      );
    }
  }

  private parseEventType(event: rpc.Api.EventResponse): string {
    const topics = event.topic || [];
    if (topics.length > 0) {
      const firstTopic = topics[0];
      if (typeof firstTopic === 'string') {
        return firstTopic;
      }
    }
    return 'unknown';
  }

  private parseEventTimestamp(event: rpc.Api.EventResponse): number {
    // Use ledger timestamp or current time as fallback
    return Math.floor(Date.now() / 1000);
  }

  private parseEventData(
    event: rpc.Api.EventResponse,
  ): Record<string, unknown> {
    return {
      topic: event.topic || [],
      value: event.value || {},
    };
  }

  getEvents(
    contractId?: string,
    eventType?: string,
    limit = 100,
  ): SorobanEvent[] {
    let filtered = Array.from(this.events.values());

    if (contractId) {
      filtered = filtered.filter((e) => e.contractId === contractId);
    }

    if (eventType) {
      filtered = filtered.filter((e) => e.type === eventType);
    }

    return filtered.slice(-limit);
  }

  getEventById(eventId: string): SorobanEvent | undefined {
    return this.events.get(eventId);
  }

  clearEvents(): void {
    this.events.clear();
    this.lastLedger = 0;
  }
}
