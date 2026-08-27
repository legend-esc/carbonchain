import { CreditStatus } from '../../../shared';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Off-chain index of an on-chain carbon credit.
 * Ready for TypeORM — uncomment decorators and add @nestjs/typeorm when DB is wired.
 *
 */
@Entity('credits')
export class CreditEntity {
  @PrimaryColumn()
  id: string;

  @Column({ name: 'project_id' })
  projectId: string;

  @Column({ name: 'vintage_year' })
  issuer: string;

  @Column({ name: 'ipfs_hash' })
  owner: string;

  @Column()
  vintageYear: number;

  @Column()
  methodology: string;

  @Column()
  geography: string;

  @Column({ type: 'varchar' })
  tonnes: string;

  @Column()
  ipfsHash: string;

  @Column({ type: 'varchar' })
  status: CreditStatus;

  @Column({ name: 'issued_at', type: 'bigint' })
  issuedAt: number;
}
