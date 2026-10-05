import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * Issue #921 — lifecycle of the off-chain → on-chain certificate hash write.
 *
 * none     — never attempted (default for new records)
 * pending  — attempt in flight or awaiting retry
 * onchain  — hash is recorded in contract state
 * failure  — retries exhausted; requires manual reconciliation
 */
export type CertificateHashStatus = 'none' | 'pending' | 'onchain' | 'failure';

/**
 * Issue #918 — lifecycle of the Soroban transaction that anchors the
 * retirement on-chain.
 *
 * pending — record written optimistically before the tx was confirmed
 * success — tx confirmed by the network (ledgerSeq is authoritative)
 * failed  — tx submitted but the network reported a failure
 * timeout — tx neither succeeded nor failed within the confirmation window
 */
export type RetirementTxStatus = 'pending' | 'success' | 'failed' | 'timeout';

@Index('idx_retirements_retired_at', ['retiredAt'])
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

  /** Issue #544 — IPFS hash of the off-chain retirement certificate PDF.
   *  Empty string for legacy retirements. */
  @Column({ default: '' })
  certificateIpfsHash: string;

  /** Issue #589 — vintage year of the credit (e.g. 2024).
   *  Zero for legacy retirements that pre-date this field. */
  @Column({ type: 'int', default: 0 })
  vintageYear: number;

  /**
   * Issue #943 — Stellar ledger sequence number at which this retirement was
   * anchored on-chain.  Zero for legacy retirements that pre-date this field.
   * The sequence is obtained from the Soroban RPC getTransaction response and
   * stored as a tamper-proof on-chain reference so certificate verifiers can
   * look up the exact ledger closure that recorded the retirement.
   */
  @Column({ type: 'int', default: 0, name: 'ledger_seq' })
  ledgerSeq: number;

  /**
   * Issue #918 — status of the Soroban transaction that anchors this
   * retirement.  Records are created with 'pending' and rolled back to
   * 'failed'/'timeout' when the network does not confirm them.
   */
  @Column({ type: 'varchar', length: 16, default: 'pending', name: 'tx_status' })
  txStatus: RetirementTxStatus;

  /**
   * Issue #921 — lifecycle of the certificate-hash write-back to the contract.
   * See {@link CertificateHashStatus}.
   */
  @Column({ type: 'varchar', length: 16, default: 'none', name: 'cert_hash_status' })
  certHashStatus: CertificateHashStatus;

  /**
   * Issue #921 — number of certificate-hash write attempts made so far.
   * Stops being retried once it reaches CERT_HASH_MAX_RETRIES.
   */
  @Column({ type: 'int', default: 0, name: 'cert_hash_retries' })
  certHashRetries: number;
}
