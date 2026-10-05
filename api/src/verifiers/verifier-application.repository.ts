import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import {
  VerifierApplicationEntity,
  VerifierApplicationStatus,
} from './verifier-application.entity';

export const VERIFIER_APPLICATION_REPOSITORY =
  'VERIFIER_APPLICATION_REPOSITORY';

export interface IVerifierApplicationRepository {
  findAll(): Promise<VerifierApplicationEntity[]>;
  findByAddress(address: string): Promise<VerifierApplicationEntity | null>;
  create(
    application: DeepPartial<VerifierApplicationEntity>,
  ): VerifierApplicationEntity;
  save(
    application: VerifierApplicationEntity,
  ): Promise<VerifierApplicationEntity>;
  saveAll(
    applications: VerifierApplicationEntity[],
  ): Promise<VerifierApplicationEntity[]>;
  updateStatus(
    address: string,
    status: VerifierApplicationStatus,
    reviewedBy: string | null,
  ): Promise<VerifierApplicationEntity | null>;
}

@Injectable()
export class VerifierApplicationRepository implements IVerifierApplicationRepository {
  constructor(
    @InjectRepository(VerifierApplicationEntity)
    private readonly repo: Repository<VerifierApplicationEntity>,
  ) {}

  async findAll(): Promise<VerifierApplicationEntity[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async findByAddress(
    address: string,
  ): Promise<VerifierApplicationEntity | null> {
    return this.repo.findOne({ where: { address } });
  }

  create(
    application: DeepPartial<VerifierApplicationEntity>,
  ): VerifierApplicationEntity {
    return this.repo.create(application);
  }

  async save(
    application: VerifierApplicationEntity,
  ): Promise<VerifierApplicationEntity> {
    return this.repo.save(application);
  }

  async saveAll(
    applications: VerifierApplicationEntity[],
  ): Promise<VerifierApplicationEntity[]> {
    return this.repo.save(applications);
  }

  async updateStatus(
    address: string,
    status: VerifierApplicationStatus,
    reviewedBy: string | null,
  ): Promise<VerifierApplicationEntity | null> {
    const entity = await this.repo.findOne({ where: { address } });
    if (!entity) return null;
    entity.status = status;
    entity.reviewedBy = reviewedBy;
    return this.repo.save(entity);
  }
}

export const verifierApplicationRepositoryProvider = {
  provide: VERIFIER_APPLICATION_REPOSITORY,
  useClass: VerifierApplicationRepository,
};
