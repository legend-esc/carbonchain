import {
  Entity,
  Column,
  PrimaryColumn,
  CreateDateColumn,
  Index,
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
}
