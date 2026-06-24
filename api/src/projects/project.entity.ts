export enum ProjectStatus {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Failed = 'failed',
}

/**
 * Off-chain index of an on-chain project profile.
 * Stores IPFS CID with status tracking to prevent orphaned files if contract calls fail.
 * Ready for TypeORM — uncomment decorators and add @nestjs/typeorm when DB is wired.
 *
 * @Entity('projects')
 */
export class ProjectEntity {
  // @PrimaryColumn()
  id: string;

  // @Column()
  name: string;

  // @Column()
  developer: string;

  // @Column()
  description: string;

  // @Column()
  location: string;

  // @Column()
  methodology: string;

  // @Column()
  documentsCid: string;

  // @Column({ type: 'varchar' })
  status: ProjectStatus;

  // @Column({ type: 'bigint' })
  createdAt: number;

  // @Column({ type: 'bigint', nullable: true })
  confirmedAt?: number;
}
