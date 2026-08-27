import { Column, Entity, PrimaryColumn } from 'typeorm';
/**
 * Off-chain index of an on-chain retirement record.
 * Ready for TypeORM — uncomment decorators and add @nestjs/typeorm when DB is wired.
 *
 */
@Entity('retirements')
export class RetirementEntity {
  @PrimaryColumn()
  id: string;

  @Column({ name: 'credit_id' })
  creditId: string;

  @Column()
  buyer: string;

  @Column({ name: 'tonnes_retired', type: 'varchar' })
  tonnesRetired: string;

  @Column()
  reason: string;

  @Column({ name: 'retired_at', type: 'bigint' })
  retiredAt: number;

  @Column({ name: 'tx_hash', default: '' })
  txHash: string;
}
