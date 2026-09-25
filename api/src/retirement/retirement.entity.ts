import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

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
}
