import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StellarService } from '../stellar/stellar.service';
import { EventEntity } from './event.entity';

/**
 * EventBackfillService — runs once on application bootstrap and fills ledger
 * gaps for every configured contract.
 *
 * Algorithm per contract:
 *   1. Query DB MAX(ledger) → lastProcessedLedger (0 if none).
 *   2. Fetch current ledger from Soroban RPC.
 *   3. If gap > 0, page through 1000-ledger chunks calling
 *      StellarService.getContractEvents and persist each event idempotently.
 */
@Injectable()
export class EventBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventBackfillService.name);
  private readonly CHUNK_SIZE = 1000;

  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('Starting event backfill check on application bootstrap');
    const contractIds = this.getContractIds();

    for (const contractId of contractIds) {
      try {
        await this.backfillContract(contractId);
      } catch (error) {
        this.logger.error(
          `Backfill failed for contract ${contractId}: ${(error as Error).message}`,
        );
      }
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

  private async backfillContract(contractId: string): Promise<void> {
    // Step 1: find the highest ledger already in DB for this contract.
    const result = await this.eventRepository
      .createQueryBuilder('e')
      .select('MAX(e.ledger)', 'maxLedger')
      .where('e.contractId = :contractId', { contractId })
      .getRawOne<{ maxLedger: string | null }>();

    const lastProcessedLedger = result?.maxLedger
      ? Number(result.maxLedger)
      : 0;

    // Step 2: get the current ledger sequence from Soroban RPC.
    let currentLedger: number;
    try {
      currentLedger = await this.stellarService.getLatestLedger();
    } catch (error) {
      this.logger.warn(
        `Could not fetch latest ledger for backfill of ${contractId}: ${(error as Error).message}`,
      );
      return;
    }

    const gap = currentLedger - lastProcessedLedger;
    if (gap <= 0) {
      this.logger.debug(
        `Contract ${contractId}: no gap (lastProcessed=${lastProcessedLedger}, current=${currentLedger})`,
      );
      return;
    }

    this.logger.log(
      `Contract ${contractId}: backfilling ${gap} ledgers ` +
        `(${lastProcessedLedger} → ${currentLedger})`,
    );

    // Step 3: page through in CHUNK_SIZE-ledger windows.
    let backfilledCount = 0;
    let fromLedger = lastProcessedLedger;

    while (fromLedger < currentLedger) {
      try {
        const events = await this.stellarService.getContractEvents(
          contractId,
          fromLedger,
        );

        for (const event of events) {
          const eventId = `${contractId}-${event.ledger}-${event.id}`;

          // Idempotency: skip if already stored.
          const existing = await this.eventRepository.findOne({
            where: { id: eventId },
          });
          if (existing) continue;

          const eventType = this.parseEventType(event);
          const entity = this.eventRepository.create({
            id: eventId,
            contractId,
            eventType,
            ledger: event.ledger,
            txHash: (event as Record<string, unknown>).txHash as string | null ?? null,
            timestamp: Math.floor(Date.now() / 1000),
            data: {
              topic: (event as Record<string, unknown>).topic ?? [],
              value: (event as Record<string, unknown>).value ?? {},
            },
          });

          await this.eventRepository.save(entity);
          backfilledCount++;
        }
      } catch (error) {
        this.logger.warn(
          `Chunk error for ${contractId} at fromLedger=${fromLedger}: ${(error as Error).message}`,
        );
      }

      fromLedger += this.CHUNK_SIZE;
    }

    this.logger.log(
      `Contract ${contractId}: backfill complete — ${backfilledCount} new events stored`,
    );
  }

  /**
   * Extract a human-readable event type from the raw Soroban event.
   * Mirrors the logic in EventsService.parseEventType.
   */
  private parseEventType(event: Record<string, unknown>): string {
    const topics = event['topic'] as unknown[] | undefined;
    if (Array.isArray(topics) && topics.length > 0) {
      const first = topics[0];
      if (typeof first === 'string') return first;
    }
    return 'unknown';
  }
}
