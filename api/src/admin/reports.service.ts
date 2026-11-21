import { Injectable, ForbiddenException } from '@nestjs/common';
import { RetirementService } from '../retirement/retirement.service';

export interface ComplianceCsvRow {
  Date: string;
  SerialNumber: string;
  ProjectID: string;
  Country: string;
  Standard: string;
  Vintage: string;
  Tonnes: string;
  IssuanceHash: string;
  RetirementBeneficiary: string;
}

/** Allowed roles for compliance export */
const ALLOWED_ROLES = new Set(['admin', 'auditor']);

@Injectable()
export class ReportsService {
  constructor(private readonly retirementService: RetirementService) {}

  /**
   * Returns an async generator that yields CSV rows as strings, including the header.
   * Streams in pages to avoid loading all records into memory at once (OOM safe).
   *
   * @param role  - Caller's role string; must be 'admin' or 'auditor'.
   */
  async *generateComplianceCsv(role: string): AsyncGenerator<string> {
    if (!ALLOWED_ROLES.has(role)) {
      throw new ForbiddenException(
        'Only admin or auditor roles may access compliance exports',
      );
    }

    // Emit CSV header
    yield this.buildCsvHeader();

    const pageSize = 500;
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await this.retirementService.listRetirements(page, pageSize);

      for (const record of result.data) {
        const row = this.recordToRow(record);
        yield this.formatCsvRow(row);
      }

      hasMore = result.data.length === pageSize;
      page += 1;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private buildCsvHeader(): string {
    return (
      'Date,Serial Number,Project ID,Country,Standard,Vintage,Tonnes,Issuance Hash,Retirement Beneficiary\r\n'
    );
  }

  private recordToRow(record: {
    id: string;
    credit_id: string;
    buyer: string;
    tonnes_retired: string;
    reason: string;
    retired_at: number;
    tx_hash: string;
  }): ComplianceCsvRow {
    // ISO 8601 date
    const date = new Date(record.retired_at * 1000).toISOString();

    // Tonnes with 0.1 resolution (1 decimal place)
    // tonnes_retired is stored as TONNES_SCALE units (1_000_000 per tonne)
    const rawTonnes = BigInt(record.tonnes_retired);
    const tonnes = (Number(rawTonnes) / 1_000_000).toFixed(1);

    return {
      Date: date,
      SerialNumber: record.id,
      ProjectID: record.credit_id,
      Country: '',       // not stored at retirement level; left blank per spec
      Standard: 'UNFCCC',
      Vintage: '',       // available on credit entity; not on retirement record
      Tonnes: tonnes,
      IssuanceHash: record.tx_hash ?? '',
      RetirementBeneficiary: record.buyer,
    };
  }

  private formatCsvRow(row: ComplianceCsvRow): string {
    const fields = [
      row.Date,
      row.SerialNumber,
      row.ProjectID,
      row.Country,
      row.Standard,
      row.Vintage,
      row.Tonnes,
      row.IssuanceHash,
      row.RetirementBeneficiary,
    ];
    return fields.map((f) => this.escapeCsvField(f)).join(',') + '\r\n';
  }

  /** RFC 4180 CSV escaping */
  private escapeCsvField(value: string): string {
    if (value.includes('"') || value.includes(',') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}
