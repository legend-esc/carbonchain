import { Entity, PrimaryColumn, Column } from 'typeorm';
import { CreditStatus } from '../../../shared';

@Entity('credits')
export class CreditEntity {
  @PrimaryColumn()
  id: string;

  @Column()
  projectId: string;

  @Column()
  issuer: string;

  @Column()
  owner: string;

  @Column()
  vintageYear: number;

  @Column()
  methodology: string;

  @Column()
  geography: string;

  @Column()
  tonnes: string;

  @Column()
  ipfsHash: string;

  @Column({ type: 'varchar' })
  status: CreditStatus;

  @Column({ type: 'bigint' })
  issuedAt: number;
}
