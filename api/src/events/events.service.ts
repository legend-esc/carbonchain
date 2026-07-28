import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StellarService } from '../stellar/stellar.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { rpc } from '@stellar/stellar-sdk';
import { CacheService } from '../common/cache.service';
import { EventEntity } from './event.entity';

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
/**
 * EventsService - Background event indexer with PostgreSQL storage.
 * Polls Soroban RPC every 30 seconds and stores events in the database.
 * API reads from DB for <50ms query latency.
 */
@Injectable()
export class EventsService implements OnModuleInit {
  private readonly logger = new Logger(EventsService.name);
  private readonly lastLedgerCache = new Map<string, number>();

  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
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
  async onModuleInit() {
    this.logger.log('EventsService initialized - loading last synced ledgers');
    // Load last synced ledger per contract from DB
    const contractIds = this.getContractIds();
    for (const contractId of contractIds) {
      const lastEvent = await this.eventRepository.findOne({
        where: { contractId },
        order: { ledger: 'DESC' },
      });
      if (lastEvent) {
        this.lastLedgerCache.set(contractId, lastEvent.ledger);
        this.logger.log(
          `Contract ${contractId}: last synced ledger = ${lastEvent.ledger}`,
        );
      }
    }
  }

  /**
   * Background indexer - runs every 30 seconds.
   * Syncs events from all configured contracts.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async indexEvents(): Promise<void> {
    if (this.isIndexing) {
      this.logger.debug('Skipping indexEvents — previous run still in progress');
      return;
    }

    this.isIndexing = true;
    try {
      const contractIds = this.getContractIds();

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

  private getContractIds(): string[] {
    return [
      this.configService.get<string>('CREDIT_REGISTRY_CONTRACT_ID'),
      this.configService.get<string>('RETIREMENT_CONTRACT_ID'),
      this.configService.get<string>('MARKETPLACE_CONTRACT_ID'),
      this.configService.get<string>('MRV_ORACLE_CONTRACT_ID'),
    ].filter((id): id is string => Boolean(id));
  }

  private async indexContractEvents(contractId: string): Promise<void> {
    try {
      const lastLedger = this.lastLedgerCache.get(contractId) || 0;
      const events = await this.stellarService.getContractEvents(
        contractId,
        lastLedger,
      );

      if (events.length === 0) return;

      for (const event of events) {
        const eventId = `${contractId}-${event.ledger}-${event.id}`;
        const eventType = this.parseEventType(event);

        // Check if event already exists (idempotency for reorgs)
        const existing = await this.eventRepository.findOne({
          where: { id: eventId },
        });
        if (existing) {
          continue;
        }

        const eventEntity = this.eventRepository.create({
          id: eventId,
          contractId,
          eventType,
          ledger: event.ledger,
          txHash: event.txHash || null,
          timestamp: this.parseEventTimestamp(event),
          data: this.parseEventData(event),
        });

        await this.eventRepository.save(eventEntity);

        this.events.set(eventId, sorobanEvent);
        this.enforceEventLimit();

        this.logger.debug(
          `Indexed event: ${eventType} from contract ${contractId} at ledger ${event.ledger}`,
        );

        // Invalidate credit cache on status-change events.
        // Issue #540: targeted tag invalidation instead of a `credits:list:*`
        // KEYS scan — mirrors CreditsService.invalidateCreditCache's tagging
        // convention (list queries are all tagged `credits:list`).
        if (CREDIT_STATUS_CHANGE_EVENTS.has(sorobanEvent.type)) {
          const creditId = sorobanEvent.data['credit_id'] as string | undefined;
          if (creditId) {
            await this.cache.del(`credits:${creditId}`);
          }
          await this.cache.invalidateTag('credits:list');
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
        // Trigger webhooks for this event
        await this.webhooksService.triggerWebhooks(eventType, {
          id: eventId,
          type: eventType,
          contractId,
          ledger: event.ledger,
          timestamp: eventEntity.timestamp,
          data: eventEntity.data,
        });
      }

      // Update last synced ledger
      const maxLedger = Math.max(...events.map((e) => e.ledger));
      this.lastLedgerCache.set(contractId, maxLedger);
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

  /**
   * Query events from PostgreSQL (fast, <50ms).
   * Replaces the old in-memory Map approach.
   */
  async getEvents(
    contractId?: string,
    eventType?: string,
    take = 50,
    skip = 0,
  ): Promise<SorobanEvent[]> {
    const limit = Math.min(take, 200);
    const where: any = {};

    if (contractId) {
      where.contractId = contractId;
    }
    if (eventType) {
      where.eventType = eventType;
    }

    const events = await this.eventRepository.find({
      where,
      order: { ledger: 'DESC' },
      take: limit,
      skip,
    });

    return events.map((e) => ({
      id: e.id,
      type: e.eventType,
      contractId: e.contractId,
      ledger: Number(e.ledger),
      timestamp: Number(e.timestamp),
      data: e.data,
    }));
  }

  async getEventById(eventId: string): Promise<SorobanEvent | undefined> {
    const event = await this.eventRepository.findOne({
      where: { id: eventId },
    });

    if (!event) return undefined;

    return {
      id: event.id,
      type: event.eventType,
      contractId: event.contractId,
      ledger: Number(event.ledger),
      timestamp: Number(event.timestamp),
      data: event.data,
    };
  }

  /**
   * Handle ledger reorg: delete events from reverted ledgers.
   * Called when a ledger closes but transactions are reverted.
   */
  async handleReorg(contractId: string, revertedLedger: number): Promise<void> {
    this.logger.warn(
      `Handling reorg: deleting events from ledger ${revertedLedger} for contract ${contractId}`,
    );

    await this.eventRepository.delete({
      contractId,
      ledger: revertedLedger,
    });

    // Update last synced ledger
    const lastEvent = await this.eventRepository.findOne({
      where: { contractId },
      order: { ledger: 'DESC' },
    });
    const newLastLedger = lastEvent ? lastEvent.ledger : 0;
    this.lastLedgerCache.set(contractId, newLastLedger);

    this.logger.log(
      `Reorg handled: new last ledger for ${contractId} = ${newLastLedger}`,
    );
  }
}
