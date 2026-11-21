import { Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * In-memory representation of a credit dispute.
 *
 * TODO: persist via TypeORM entity (a `disputes` table) so records survive
 * service restarts and can be queried with pagination.
 */
export interface DisputeRecord {
  /** UUID assigned at creation time. */
  id: string;
  /** Credit that is being disputed. */
  creditId: string;
  /** Stellar address of the verifier who filed the dispute. */
  verifierAddress: string;
  /** Human-readable dispute reason. */
  reason: string;
  /** URLs to supporting evidence documents (e.g. IPFS CIDs). */
  evidenceUrls: string[];
  /** Transaction hash proving the dispute bond was locked on-chain. */
  bondTxHash: string;
  status: 'Pending' | 'Resolved' | 'Rejected';
  /** Admin resolution note (set when status changes to Resolved or Rejected). */
  resolution?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

/**
 * DisputesService
 *
 * Manages the lifecycle of credit disputes filed by verifiers.
 * Currently backed by an in-memory Map; replace with a TypeORM repository
 * when persistence is required.
 */
@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  /** In-memory store keyed by dispute id. */
  private readonly store = new Map<string, DisputeRecord>();

  /**
   * File a new dispute for `creditId`.
   * Assigns a UUID, sets status to Pending, and logs the action.
   */
  fileDispute(
    creditId: string,
    verifierAddress: string,
    reason: string,
    evidenceUrls: string[],
    bondTxHash: string,
  ): DisputeRecord {
    const record: DisputeRecord = {
      id: crypto.randomUUID(),
      creditId,
      verifierAddress,
      reason,
      evidenceUrls,
      bondTxHash,
      status: 'Pending',
      createdAt: new Date(),
    };

    this.store.set(record.id, record);

    this.logger.log(
      `[dispute:filed] id=${record.id} creditId=${creditId} verifier=${verifierAddress}`,
    );

    return record;
  }

  /**
   * Return all disputes, optionally filtered by `status`.
   */
  listDisputes(status?: string): DisputeRecord[] {
    const all = Array.from(this.store.values());
    if (status) {
      return all.filter((d) => d.status === status);
    }
    return all;
  }

  /**
   * Retrieve a single dispute by id.
   * Throws `NotFoundException` if the dispute does not exist.
   */
  getDispute(id: string): DisputeRecord {
    const record = this.store.get(id);
    if (!record) {
      throw new NotFoundException(`Dispute ${id} not found`);
    }
    return record;
  }

  /**
   * Resolve or reject an existing dispute.
   * Throws `NotFoundException` if the dispute does not exist.
   */
  resolveDispute(
    id: string,
    resolution: string,
    status: 'Resolved' | 'Rejected',
  ): DisputeRecord {
    const record = this.getDispute(id);

    record.resolution = resolution;
    record.status = status;
    record.resolvedAt = new Date();

    this.store.set(id, record);

    this.logger.log(
      `[dispute:resolved] id=${id} status=${status} resolution="${resolution}"`,
    );

    // TODO: trigger on-chain dispute count update for the verifier's reputation.

    return record;
  }
}
