import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

/**
 * Off-chain index of an on-chain retirement record.
 *
 * @Index decorator mirrors the SQL index created by migration
 * 1748476800000-AddRetirementRetiredAtIndex.ts so that TypeORM's migration
 * generator produces a no-op when the schema is already up to date.
 */
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

  @Index('idx_retirements_retired_at')
  @Column({ type: 'bigint' })
  retiredAt: number;

  @Column({ default: '' })
  txHash: string;
}
