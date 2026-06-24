/**
 * Off-chain index of an on-chain retirement record.
 * Ready for TypeORM — uncomment decorators and add @nestjs/typeorm when DB is wired.
 *
 * @Entity('retirements')
 */
export class RetirementEntity {
  // @PrimaryColumn()
  id: string;

  // @Column()
  creditId: string;

  // @Column()
  buyer: string;

  // @Column()
  tonnesRetired: string;

  // @Column()
  reason: string;

  // @Column({ type: 'bigint' })
  retiredAt: number;

  // @Column({ default: '' })
  txHash: string;
}
