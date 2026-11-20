import {
  Entity,
  Column,
  PrimaryColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * EventEntity stores indexed contract events from Soroban.
 * Replaces in-memory Map for persistent, queryable event storage.
 */
@Entity('events')
@Index(['contractId', 'ledger'])
@Index(['eventType'])
@Index(['ledger'])
export class EventEntity {
  /** Unique event identifier: `${contractId}-${ledger}-${internalId}` */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id: string;

  /** Contract address that emitted the event */
  @Column({ type: 'varchar', length: 100, name: 'contract_id' })
  @Index()
  contractId: string;

  /** Event type (e.g., 'CreditMinted', 'OfferNew') */
  @Column({ type: 'varchar', length: 100, name: 'event_type' })
  @Index()
  eventType: string;

  /** Ledger sequence number where the event was emitted */
  @Column({ type: 'bigint' })
  @Index()
  ledger: number;

  /** Transaction hash that produced the event */
  @Column({ type: 'varchar', length: 100, name: 'tx_hash', nullable: true })
  txHash: string | null;

  /** Unix timestamp when the event was emitted */
  @Column({ type: 'bigint' })
  timestamp: number;

  /** Event data payload (topics + value) */
  @Column({ type: 'jsonb' })
  data: Record<string, unknown>;

  /** Timestamp when this record was created in the database */
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
