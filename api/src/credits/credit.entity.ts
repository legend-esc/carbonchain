import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
} from 'typeorm';
import { CreditStatus } from '../shared';

/**
 * Off-chain index of an on-chain carbon credit.
 *
 * @Index decorators mirror the SQL indexes created by migration
 * 1748390400000-AddCreditIndexes.ts so that TypeORM's migration generator
 * produces a no-op when the schema is already up to date.
 *
 * Composite index: (status, methodology, geography) — covers the most common
 * marketplace multi-field filter.
 * Single-column indexes: vintage_year (range queries) and issuer (portfolio).
 */
@Entity('credits')
@Index('idx_credits_status_methodology_geography', ['status', 'methodology', 'geography'])
import { Entity, PrimaryColumn, Column } from 'typeorm';
import { CreditStatus } from '../../../shared';

@Entity('credits')
export class CreditEntity {
  @PrimaryColumn()
  id: string;

  @Column()
  projectId: string;

  @Index('idx_credits_owner_address')
  @Column()
  issuer: string;

  @Index('idx_credits_vintage_year')
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
