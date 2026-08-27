import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('projects')
export class ProjectEntity {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @Column()
  developer: string;

  @Column()
  description: string;

  @Column()
  location: string;

  @Column()
  methodology: string;

  @Column({ default: '' })
  documents_cid: string;
}