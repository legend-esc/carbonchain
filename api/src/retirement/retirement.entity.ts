import { Entity, PrimaryColumn, Column } from 'typeorm';

/**
 * Tracks the on-chain finality state of the retirement transaction.
 *
 * #918 — confirm-on-finality
 *   pending  → submission accepted; waiting for ledger close
 *   success  → transaction closed successfully (default terminal state)
 *   failed   → transaction closed with FAILED status; DB rolled back
 *   timeout  → polling timed out; treated as failed for reconciliation
 */
export type TxStatus = 'pending' | 'success' | 'failed' | 'timeout';

/**
 * Tracks whether the certificate IPFS hash has been written on-chain.
 *
 * #921 — certificate hash reconciliation
 *   none     → hash has not been attempted yet
 *   pending  → write attempted; waiting for confirmation
 *   onchain  → hash confirmed written on-chain
 *   failure  → all bounded retries exhausted; requires manual reconciliation
 */
export type CertificateHashStatus = 'none' | 'pending' | 'onchain' | 'failure';

@Entity('retirements')
export class RetirementEntity {
  @PrimaryColumn()
  id: string;

  @Column()
  creditId: string;

  @Column()
  buyer: string;

  @Column()
  tonnesRetired: string;

  @Column()
  reason: string;

  @Column({ type: 'bigint' })
  retiredAt: number;

  @Column({ default: '' })
  txHash: string;

  /**
   * On-chain finality status for this retirement transaction.
   * Defaults to 'pending' on creation; updated by confirmTransaction polling.
   * #918
   */
  @Column({ type: 'varchar', default: 'pending' })
  txStatus: TxStatus;

  /**
   * Tracks whether the retirement certificate IPFS hash has been written on-chain.
   * Defaults to 'none'; updated by CertHashReconciler.
   * #921
   */
  @Column({ type: 'varchar', default: 'none' })
  certHashStatus: CertificateHashStatus;

  /**
   * Number of cert-hash write attempts made by CertHashReconciler.
   * Used to enforce the bounded-retry ceiling.
   * #921
   */
  @Column({ type: 'int', default: 0 })
  certHashRetries: number;

  /**
   * The IPFS CID / hash of the retirement certificate.
   * Set after successful PDF generation and IPFS pinning.
   * #921
   */
  @Column({ default: '' })
  certificateIpfsHash: string;
}
