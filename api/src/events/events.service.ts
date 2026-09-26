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

/**
 * EventsService - Background event indexer with PostgreSQL storage.
 * Polls Soroban RPC every 30 seconds and stores events in the database.
 * API reads from DB for <50ms query latency.
 */
@Injectable()
export class EventsService implements OnModuleInit {
  private readonly logger = new Logger(EventsService.name);
  private readonly lastLedgerCache = new Map<string, number>();
  private isIndexing = false;
  private readonly maxEvents: number;

  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private stellarService: StellarService,
    private configService: ConfigService,
    private webhooksService: WebhooksService,
    private readonly cache: CacheService,
  ) {
    this.maxEvents = this.configService.get<number>(
      'EVENT_STORE_MAX_SIZE',
      MAX_EVENTS_DEFAULT,
    );
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('EventsService initialized - loading last synced ledgers');
    // Check whether stored lastLedger is ahead of the node's current sequence on resume
    let currentLedger = 0;
    try {
      if (typeof this.stellarService.getLatestLedger === 'function') {
        currentLedger = await this.stellarService.getLatestLedger();
      } else if (typeof this.stellarService.getSorobanRpcServer === 'function') {
        const server = this.stellarService.getSorobanRpcServer();
        if (server && typeof server.getLatestLedger === 'function') {
          const res = await server.getLatestLedger();
          currentLedger = res?.sequence || 0;
        }
      }
    } catch (error) {
      this.logger.warn(
        `Could not retrieve latest ledger on resume: ${(error as Error).message}`,
      );
    }

    // Load last synced ledger per contract from DB
    const contractIds = this.getContractIds();
    for (const contractId of contractIds) {
      const lastEvent = await this.eventRepository.findOne({
        where: { contractId },
        order: { ledger: 'DESC' },
      });
      if (lastEvent) {
        let lastLedger = Number(lastEvent.ledger);
        if (currentLedger > 0 && lastLedger > currentLedger) {
          this.logger.warn(
            `Contract ${contractId}: stored lastLedger ${lastLedger} is ahead of node current sequence ${currentLedger}. Handling reorg.`,
          );
          for (let reverted = lastLedger; reverted > currentLedger; reverted--) {
            await this.handleReorg(contractId, reverted);
          }
          lastLedger = this.lastLedgerCache.get(contractId) || currentLedger;
        } else {
          this.lastLedgerCache.set(contractId, lastLedger);
        }
        this.logger.log(
          `Contract ${contractId}: last synced ledger = ${lastLedger}`,
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
      this.logger.debug(
        'Skipping indexEvents — previous run still in progress',
      );
      return;
    }

    this.isIndexing = true;
    try {
      const contractIds = this.getContractIds();

      for (const contractId of contractIds) {
        await this.indexContractEvents(contractId);
      }

      // Retry failed webhook deliveries
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

        this.logger.debug(
          `Indexed event: ${eventType} from contract ${contractId} at ledger ${event.ledger}`,
        );

        const sorobanEvent: SorobanEvent = {
          id: eventId,
          type: eventType,
          contractId,
          ledger: event.ledger,
          timestamp: eventEntity.timestamp,
          data: eventEntity.data,
        };

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

        // Trigger webhooks for this event
        await this.webhooksService.triggerWebhooks(
          sorobanEvent.type,
          sorobanEvent,
        );
      }

      // Keep the store bounded (EVENT_STORE_MAX_SIZE).
      await this.trimEventStore();

      // Update last synced ledger
      const maxLedger = Math.max(...events.map((e) => e.ledger));
      this.lastLedgerCache.set(contractId, maxLedger);
    } catch (error) {
      this.logger.error(
        `Failed to index events for contract ${contractId}: ${(error as Error).message}`,
      );
    }
  }

  private async trimEventStore(): Promise<void> {
    try {
      const count = await this.eventRepository.count();
      if (count <= this.maxEvents) return;

      const overflow = count - this.maxEvents;
      const oldest = await this.eventRepository.find({
        order: { ledger: 'ASC' },
        take: overflow,
        select: { id: true },
      });
      if (oldest.length > 0) {
        await this.eventRepository.delete(oldest.map((e) => e.id));
        this.logger.warn(
          `Trimmed ${oldest.length} events from store (max ${this.maxEvents})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to trim event store: ${(error as Error).message}`,
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
   * Query events from PostgreSQL using keyset (cursor) pagination.
   *
   * Issue #931 — offset-based pagination (skip) is unstable under concurrent
   * writes because appended rows shift offsets and cause duplicate/missed
   * pages.  Keyset pagination pins a cursor to a monotonic `(ledger, id)`
   * pair so concurrent inserts never affect in-flight pages.
   *
   * Cursor semantics:
   *  - Pass `beforeCursor` to fetch the next page of events OLDER than the
   *    cursor (i.e. lower ledger / earlier id).  The cursor value is the `id`
   *    field of the last event on the previous page.
   *  - The response includes a `nextCursor` field — pass it as `beforeCursor`
   *    on the subsequent request.  A null `nextCursor` means there are no
   *    more pages.
   *  - `take` / `skip` remain accepted as deprecated aliases so existing
   *    consumers keep working without changes.
   *
   * @param contractId  Optional contract address filter.
   * @param eventType   Optional event-type filter.
   * @param limit       Page size (max 200, default 50).
   * @param beforeCursor Opaque cursor from a previous response (keyset mode).
   * @param skip        Deprecated offset (only used when beforeCursor absent).
   */
  async getEvents(
    contractId?: string,
    eventType?: string,
    limit = 50,
    skip = 0,
    beforeCursor?: string,
  ): Promise<{ events: SorobanEvent[]; nextCursor: string | null }> {
    const pageSize = Math.min(limit, 200);

    const qb = this.eventRepository
      .createQueryBuilder('e')
      .orderBy('e.ledger', 'DESC')
      .addOrderBy('e.id', 'DESC')
      .take(pageSize);

    if (contractId) {
      qb.andWhere('e.contractId = :contractId', { contractId });
    }
    if (eventType) {
      qb.andWhere('e.eventType = :eventType', { eventType });
    }

    if (beforeCursor) {
      // Keyset path — look up the anchor row to get its (ledger, id) values.
      const anchor = await this.eventRepository.findOne({
        where: { id: beforeCursor },
        select: { id: true, ledger: true },
      });

      if (anchor) {
        // Return rows with a ledger strictly less than the anchor, OR on the
        // same ledger but with a lexicographically smaller id (stable tie-break).
        qb.andWhere(
          '(e.ledger < :anchorLedger OR (e.ledger = :anchorLedger AND e.id < :anchorId))',
          { anchorLedger: anchor.ledger, anchorId: anchor.id },
        );
      }
    } else if (skip > 0) {
      // Deprecated offset path — kept for backward compatibility.
      qb.skip(skip);
    }

    const rows = await qb.getMany();

    const events = rows.map((e) => ({
      id: e.id,
      type: e.eventType,
      contractId: e.contractId,
      ledger: Number(e.ledger),
      timestamp: Number(e.timestamp),
      data: e.data,
    }));

    // nextCursor is the id of the last row returned; null when the page is
    // smaller than pageSize (no more rows exist).
    const nextCursor =
      rows.length === pageSize ? rows[rows.length - 1].id : null;

    return { events, nextCursor };
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
    const newLastLedger = lastEvent ? Number(lastEvent.ledger) : 0;
    this.lastLedgerCache.set(contractId, newLastLedger);

    this.logger.log(
      `Reorg handled: new last ledger for ${contractId} = ${newLastLedger}`,
    );
  }
}
