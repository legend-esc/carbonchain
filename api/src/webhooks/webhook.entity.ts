import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Durable store for registered webhooks. Replaces the in-memory
 * CacheService-backed Map in WebhooksService so registrations survive
 * restarts and stay consistent across pods.
 */
@Entity('webhooks')
export class WebhookEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  url: string;

  @Column('text', { array: true })
  events: string[];

  @Index()
  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastTriggeredAt?: Date;

  @Column({ default: 0 })
  failureCount: number;
}
