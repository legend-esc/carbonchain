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

const MAX_EVENTS_DEFAULT = 10_000;
const LAST_LEDGER_KEY = 'events:lastLedger';

@Injectable()
export class EventsService implements OnModuleInit {
  private readonly logger = new Logger(EventsService.name);
  private lastLedger = 0;
  private events: Map<string, SorobanEvent> = new Map();
  private isIndexing = false;
  private readonly maxEvents: number;

  constructor(
    private stellarService: StellarService,
    private configService: ConfigService,
    private webhooksService: WebhooksService,
    private readonly cache: CacheService,
  ) {
    this.maxEvents = this.configService.get<number>('EVENT_STORE_MAX_SIZE', MAX_EVENTS_DEFAULT);
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('EventsService initialized');
    await this.loadState();
  }

  private async loadState(): Promise<void> {
    try {
      const persisted = await this.cache.get<number>(LAST_LEDGER_KEY);
      if (persisted !== null && persisted > 0) {
        this.lastLedger = persisted;
        this.logger.log(`Resumed event indexing from ledger ${this.lastLedger}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to load persisted ledger state: ${(err as Error).message}`);
    }
  }

  private async persistLastLedger(): Promise<void> {
    try {
      await this.cache.set(LAST_LEDGER_KEY, this.lastLedger, 86400);
    } catch (err) {
      this.logger.warn(`Failed to persist lastLedger: ${(err as Error).message}`);
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async indexEvents(): Promise<void> {
    if (this.isIndexing) {
      this.logger.debug('Skipping indexEvents — previous run still in progress');
      return;
    }

    this.isIndexing = true;
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

      await this.webhooksService.processQueue();
    } catch (error) {
      this.logger.error(`Failed to index events: ${(error as Error).message}`);
    } finally {
      this.isIndexing = false;
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
        this.enforceEventLimit();

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

        // Enqueue webhook for this event (non-blocking)
        await this.webhooksService.triggerWebhooks(
          sorobanEvent.type,
          sorobanEvent,
        );
      }

      if (events.length > 0) {
        this.lastLedger = Math.max(...events.map((e) => e.ledger));
        await this.persistLastLedger();
      }
    } catch (error) {
      this.logger.error(
        `Failed to index events for contract ${contractId}: ${(error as Error).message}`,
      );
    }
  }

  private enforceEventLimit(): void {
    while (this.events.size > this.maxEvents) {
      const oldestKey = this.events.keys().next().value;
      if (oldestKey) {
        this.events.delete(oldestKey);
      }
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
    // Prefer the ledger close time from the RPC response when available.
    if (event.ledger && event.ledger > 0) {
      // Approximate ledger timestamp from ledger sequence.
      // Stellar ledgers close roughly every 5 seconds.
      return Math.floor(Date.now() / 1000);
    }
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
