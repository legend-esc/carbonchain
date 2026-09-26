import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Persists a registered verifier address and its associated metadata.
 *
 * The `address` is the Stellar account address of the verifier and acts as
 * the primary key — it is unique by definition on-chain.
 *
 * `capabilities` stores the list of `ServiceType` strings the verifier has
 * self-configured on-chain (e.g. `["CreditApproval", "MRVReview"]`).
 *
 * `reputation` is a cached snapshot of the on-chain reputation scores
 * (approval_count, dispute_count) and is refreshed on each sync.
 *
 * `syncedAt` (issue #946) — timestamp of the last successful on-chain
 * reconcile for this record. Consumers can check this to know how stale the
 * off-chain view is.
 *
 * `unstable` (issue #946) — set to true when the DB record is present but
 * the address is no longer found in the on-chain verifier list. This signals
 * that a direct chain-side removal may have happened outside the API.
 */
@Entity('verifiers')
export class VerifierEntity {
  /**
   * Stellar account address — used as the primary key.
   * Added as a unique index for fast lookup.
   */
  @PrimaryColumn({ type: 'varchar', length: 56 })
  @Index({ unique: true })
  address: string;

  /** Optional human-readable display name for the verifier node. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  /**
   * Self-configured service capabilities, stored as a JSON array.
   * Example: `["CreditApproval", "MRVReview"]`
   */
  @Column({ type: 'jsonb', default: '[]' })
  capabilities: string[];

  /**
   * Cached on-chain reputation scores.
   * `approvalCount` — number of credits approved.
   * `disputeCount`  — number of disputes raised against this verifier.
   */
  @Column({ type: 'jsonb', default: '{}' })
  reputation: {
    approvalCount: number;
    disputeCount: number;
  };

  /** Timestamp when this verifier was first persisted to the database. */
  @CreateDateColumn({ name: 'registered_at' })
  registeredAt: Date;

  /**
   * Issue #946 — Timestamp of the last successful on-chain reconcile for
   * this record. Null for records that pre-date the sync feature. Consumers
   * can use this to gauge how stale the cached data is relative to the chain.
   */
  @UpdateDateColumn({ name: 'synced_at', nullable: true })
  syncedAt: Date | null;

  /**
   * Issue #946 — True when this DB record is present but the address is no
   * longer found in the on-chain `get_verifier_list` response. Indicates a
   * possible out-of-band chain-side deregistration. The record is preserved
   * (never deleted) but flagged so the UI can warn operators.
   */
  @Column({ type: 'boolean', default: false, name: 'unstable' })
  unstable: boolean;
}
