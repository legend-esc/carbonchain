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
  ) {}

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
    try {
      const contractIds = this.getContractIds();

      for (const contractId of contractIds) {
        await this.indexContractEvents(contractId);
      }

      // Retry failed webhook deliveries
      await this.webhooksService.retryFailedDeliveries();
    } catch (error) {
      this.logger.error(`Failed to index events: ${(error as Error).message}`);
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

        this.logger.debug(
          `Indexed event: ${eventType} from contract ${contractId} at ledger ${event.ledger}`,
        );

        // Invalidate credit cache on status-change events
        if (CREDIT_STATUS_CHANGE_EVENTS.has(eventType)) {
          const creditId = eventEntity.data['credit_id'] as string | undefined;
          if (creditId) {
            await this.cache.del(`credits:${creditId}`);
          }
          await this.cache.delPattern('credits:list:*');
          this.logger.debug(`Cache invalidated after event: ${eventType}`);
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
