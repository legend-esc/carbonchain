import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VerifierEntity } from './verifier.entity';

export const VERIFIER_REPOSITORY = 'VERIFIER_REPOSITORY';

/**
 * Repository interface for verifier persistence.
 * Keeps the service decoupled from the TypeORM implementation for testing.
 */
export interface IVerifierRepository {
  findAll(): Promise<VerifierEntity[]>;
  findByAddress(address: string): Promise<VerifierEntity | null>;
  save(verifier: VerifierEntity): Promise<VerifierEntity>;
  saveAll(verifiers: VerifierEntity[]): Promise<VerifierEntity[]>;
  upsert(verifier: VerifierEntity): Promise<VerifierEntity>;
  delete(address: string): Promise<void>;
}

/**
 * TypeORM-backed repository for `VerifierEntity`.
 *
 * Uses `upsert` (INSERT … ON CONFLICT DO UPDATE) so that the on-startup
 * sync job can reconcile the off-chain table with the on-chain list without
 * duplicates.
 */
@Injectable()
export class VerifierRepository implements IVerifierRepository {
  constructor(
    @InjectRepository(VerifierEntity)
    private readonly repo: Repository<VerifierEntity>,
  ) {}

  /** Return all persisted verifiers ordered by address. */
  async findAll(): Promise<VerifierEntity[]> {
    return this.repo.find({ order: { address: 'ASC' } });
  }

  /** Look up a single verifier by Stellar address. Returns null if not found. */
  async findByAddress(address: string): Promise<VerifierEntity | null> {
    return this.repo.findOne({ where: { address } });
  }

  /** Persist a new verifier record. */
  async save(verifier: VerifierEntity): Promise<VerifierEntity> {
    return this.repo.save(verifier);
  }

  /** Persist multiple verifier records in a single transaction. */
  async saveAll(verifiers: VerifierEntity[]): Promise<VerifierEntity[]> {
    return this.repo.save(verifiers);
  }

  /**
   * Insert or update a verifier by address.
   *
   * Uses TypeORM's `save` with conflict resolution on the primary key so that
   * the on-startup sync can run safely even if some verifiers already exist.
   */
  async upsert(verifier: VerifierEntity): Promise<VerifierEntity> {
    await this.repo.upsert(verifier, ['address']);
    return this.repo.findOne({ where: { address: verifier.address } }) as Promise<VerifierEntity>;
  }

  /** Remove a verifier from the off-chain index. */
  async delete(address: string): Promise<void> {
    await this.repo.delete({ address });
  }
}

/**
 * Factory provider token — allows injection without coupling to the
 * concrete `VerifierRepository` class in tests.
 */
export const verifierRepositoryProvider = {
  provide: VERIFIER_REPOSITORY,
  useClass: VerifierRepository,
};
