import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { WebhookEntity } from './webhook.entity';

/**
 * Durable store for webhook delivery attempts, replacing the in-memory
 * CacheService-backed Map so delivery status survives restarts and is
 * consistent across pods.
 */
@Entity('webhook_deliveries')
export class WebhookDeliveryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @ManyToOne(() => WebhookEntity, { onDelete: 'CASCADE' })
  webhook: WebhookEntity;

  @Column()
  webhookId: string;

  @Index()
  @Column()
  eventId: string;

  @Column({ default: 'pending' })
  status: 'pending' | 'success' | 'failed';

  @Column({ default: 0 })
  attempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  nextRetryAt?: Date;
}
