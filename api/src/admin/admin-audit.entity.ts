import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * AdminAuditEntity — immutable row written atomically alongside every
 * admin mutation.  Captures the full who/what/when/before/after so
 * compliance (Phase 6) and post-incident review do not need to reconstruct
 * the audit trail from generic contract events.
 *
 * Issue #934.
 */
@Entity('admin_audit')
@Index(['actor'])
@Index(['action'])
@Index(['createdAt'])
export class AdminAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** JWT `sub` / `account` claim — the Stellar public key of the acting admin. */
  @Column({ type: 'varchar', length: 100 })
  @Index()
  actor: string;

  /**
   * Canonical action name, e.g. `pause_contract`, `suspend_verifier`,
   * `set_min_stake`, `slash_verifier`, `set_required_approvals`,
   * `flag_credit`, `register_verifier`, `configure_verifier`,
   * `register_methodology`.
   */
  @Column({ type: 'varchar', length: 100 })
  action: string;

  /** The primary subject of the action (contractId, verifierId, creditId, etc.). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  target: string | null;

  /** Snapshot of state / arguments BEFORE the mutation (nullable for creates). */
  @Column({ type: 'jsonb', nullable: true, name: 'before_state' })
  beforeState: Record<string, unknown> | null;

  /** Snapshot of state / result AFTER the mutation. */
  @Column({ type: 'jsonb', nullable: true, name: 'after_state' })
  afterState: Record<string, unknown> | null;

  /** Client IP address (from X-Forwarded-For or socket remote address). */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  /** User-Agent header. */
  @Column({ type: 'text', nullable: true, name: 'user_agent' })
  userAgent: string | null;

  /** Request-ID propagated through the middleware chain. */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'request_id' })
  requestId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  @Index()
  createdAt: Date;
}
