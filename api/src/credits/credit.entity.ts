import { CreditStatus } from '../shared';

/**
 * Off-chain index of an on-chain carbon credit.
 * Ready for TypeORM — uncomment decorators and add @nestjs/typeorm when DB is wired.
 *
 * @Entity('credits')
 */
export class CreditEntity {
  // @PrimaryColumn()
  id: string;

  // @Column()
  projectId: string;

  // @Column()
  issuer: string;

  // @Column()
  vintageYear: number;

  // @Column()
  methodology: string;

  // @Column()
  geography: string;

  // @Column()
  tonnes: string;

  // @Column()
  ipfsHash: string;

  // @Column({ type: 'varchar' })
  status: CreditStatus;

  // @Column({ type: 'bigint' })
  issuedAt: number;
}
