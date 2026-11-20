import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

/**
 * Issue #1301: Audit Log Service with Tamper-Evident Hash Chaining
 * Maintains immutable log of administrative actions with cryptographic integrity
 */
interface AuditLogEntry {
  id: string;
  timestamp: Date;
  actor: string; // Admin address or identity
  action: string; // e.g., 'oracle.configured', 'verifier.approved', 'fee.changed'
  payload: any; // Action details
  previousHash: string; // Hash of previous entry (chain)
  entryHash: string; // SHA-256 hash of this entry
  signature?: string; // Optional RSA signature for non-repudiation
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);
  private lastHash = '0'.repeat(64); // Genesis hash (all zeros)

  constructor(
    @InjectRepository(AuditLogEntry)
    private auditLogRepository: Repository<AuditLogEntry>,
  ) {
    this.initializeLastHash();
  }

  /**
   * Log an administrative action with tamper-evident hash chaining
   */
  async logAction(
    actor: string,
    action: string,
    payload: any,
  ): Promise<AuditLogEntry> {
    const timestamp = new Date();
    const previousHash = this.lastHash;

    // Create entry object (excluding entryHash initially)
    const entryData = {
      timestamp: timestamp.toISOString(),
      actor,
      action,
      payload: JSON.stringify(payload),
      previousHash,
    };

    // Compute hash of entry (hash chain)
    const entryHash = this.computeHash(entryData);

    // Create final entry
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      timestamp,
      actor,
      action,
      payload,
      previousHash,
      entryHash,
    };

    // Persist to database
    const savedEntry = await this.auditLogRepository.save(entry);

    // Update last hash for next entry
    this.lastHash = entryHash;

    this.logger.log(
      `✓ Audit log entry recorded: ${action} by ${actor} (hash: ${entryHash.substring(0, 16)}...)`,
    );

    return savedEntry;
  }

  /**
   * Verify the integrity of the entire audit log chain
   * Returns true if all hashes are correct and chain is unbroken
   */
  async verifyChainIntegrity(): Promise<{
    valid: boolean;
    totalEntries: number;
    lastValidIndex: number;
    details: string;
  }> {
    const entries = await this.auditLogRepository.find({
      order: { timestamp: 'ASC' },
    });

    let currentHash = '0'.repeat(64); // Genesis
    let lastValidIndex = -1;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Verify this entry's hash
      const expectedHash = this.computeHash({
        timestamp: entry.timestamp.toISOString(),
        actor: entry.actor,
        action: entry.action,
        payload: JSON.stringify(entry.payload),
        previousHash: entry.previousHash,
      });

      if (expectedHash !== entry.entryHash) {
        this.logger.warn(
          `✗ Hash mismatch at index ${i}: expected ${expectedHash}, got ${entry.entryHash}`,
        );
        return {
          valid: false,
          totalEntries: entries.length,
          lastValidIndex,
          details: `Hash integrity broken at entry ${i}: ${entry.action}`,
        };
      }

      // Verify this entry's previousHash matches the previous entry's hash
      if (entry.previousHash !== currentHash) {
        this.logger.warn(
          `✗ Chain break at index ${i}: previousHash mismatch`,
        );
        return {
          valid: false,
          totalEntries: entries.length,
          lastValidIndex,
          details: `Chain integrity broken at entry ${i}: previousHash mismatch`,
        };
      }

      currentHash = entry.entryHash;
      lastValidIndex = i;
    }

    this.logger.log(`✓ Audit chain verified: ${entries.length} entries, all hashes valid`);

    return {
      valid: true,
      totalEntries: entries.length,
      lastValidIndex,
      details: 'All entries verified, chain integrity intact',
    };
  }

  /**
   * Query audit log with optional filtering
   */
  async queryLog(filters?: {
    actor?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<AuditLogEntry[]> {
    let query = this.auditLogRepository.createQueryBuilder('log');

    if (filters?.actor) {
      query = query.where('log.actor = :actor', { actor: filters.actor });
    }

    if (filters?.action) {
      query = query.andWhere('log.action = :action', { action: filters.action });
    }

    if (filters?.startDate) {
      query = query.andWhere('log.timestamp >= :startDate', {
        startDate: filters.startDate,
      });
    }

    if (filters?.endDate) {
      query = query.andWhere('log.timestamp <= :endDate', {
        endDate: filters.endDate,
      });
    }

    return query.orderBy('log.timestamp', 'DESC').getMany();
  }

  /**
   * Get entry by hash (useful for verification)
   */
  async getEntryByHash(entryHash: string): Promise<AuditLogEntry | null> {
    return this.auditLogRepository.findOne({ where: { entryHash } });
  }

  /**
   * Compute SHA-256 hash of entry data
   */
  private computeHash(data: any): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  /**
   * Initialize last hash from database
   */
  private async initializeLastHash(): Promise<void> {
    try {
      const lastEntry = await this.auditLogRepository.findOne({
        order: { timestamp: 'DESC' },
      });

      if (lastEntry) {
        this.lastHash = lastEntry.entryHash;
      }
    } catch (error) {
      this.logger.warn('Failed to initialize last hash from database:', error);
    }
  }

  /**
   * Export audit log entries for compliance reporting
   */
  async exportLog(format: 'json' | 'csv' = 'json'): Promise<string> {
    const entries = await this.auditLogRepository.find({
      order: { timestamp: 'ASC' },
    });

    if (format === 'json') {
      return JSON.stringify(entries, null, 2);
    }

    // CSV format
    const headers = ['timestamp', 'actor', 'action', 'entryHash', 'previousHash'];
    const rows = entries.map((e) =>
      [
        e.timestamp.toISOString(),
        e.actor,
        e.action,
        e.entryHash,
        e.previousHash,
      ].join(','),
    );

    return [headers.join(','), ...rows].join('\n');
  }
}
