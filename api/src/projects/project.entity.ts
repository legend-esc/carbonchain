import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('projects')
export class ProjectEntity {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  developer: string;

  @Column({ nullable: true })
  description: string;

  @Column({ nullable: true })
  location: string;

  @Column({ nullable: true })
  methodology: string;

  @Column({ default: '' })
  documentsCid: string;
}
