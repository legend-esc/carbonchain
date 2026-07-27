import { Entity, PrimaryColumn, Column } from 'typeorm';

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
}
