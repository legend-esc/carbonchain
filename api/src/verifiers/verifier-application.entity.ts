import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum VerifierApplicationStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
}

@Entity('verifier_applications')
export class VerifierApplicationEntity {
  @PrimaryColumn({ type: 'varchar', length: 56 })
  address: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  @Column({ type: 'jsonb', default: '[]' })
  capabilities: string[];

  @Column({ type: 'text', nullable: true })
  documentsCid: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stakeToken: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stakeAmount: string | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: VerifierApplicationStatus.Pending,
  })
  status: VerifierApplicationStatus;

  @Column({ type: 'text', nullable: true })
  reviewedBy: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', nullable: true })
  updatedAt: Date | null;
}
