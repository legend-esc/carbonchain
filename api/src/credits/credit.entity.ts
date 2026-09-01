import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { CreditStatus } from '../../../shared';

@Entity('credits')
@Index('idx_credits_status_methodology_geography', [
  'status',
  'methodology',
  'geography',
])
@Index('idx_credits_owner_address', ['issuer'])
@Index('idx_credits_vintage_year', ['vintageYear'])
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
