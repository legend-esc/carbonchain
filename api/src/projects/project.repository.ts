import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ProjectProfile } from '../../../shared';
import { ProjectEntity } from './project.entity';

export const PROJECT_REPOSITORY = 'PROJECT_REPOSITORY';

export interface IProjectRepository {
  save(project: ProjectProfile): Promise<ProjectProfile>;
  findById(id: string): Promise<ProjectProfile | undefined>;
  findAll(): Promise<ProjectProfile[]>;
}

@Injectable()
export class TypeOrmProjectRepository implements IProjectRepository {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly repository: Repository<ProjectEntity>,
  ) {}

  save(project: ProjectProfile): Promise<ProjectProfile> {
    return this.repository.save(project) as Promise<ProjectProfile>;
  }

  findById(id: string): Promise<ProjectProfile | undefined> {
    return this.repository.findOne({ where: { id } }) as Promise<ProjectProfile | undefined>;
  }

  findAll(): Promise<ProjectProfile[]> {
    return this.repository.find() as Promise<ProjectProfile[]>;
  }
}