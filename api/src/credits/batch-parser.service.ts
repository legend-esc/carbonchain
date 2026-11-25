/**
 * Issue #1294 — Parse and validate CSV/XLSX batch credit submissions
 */

import { Injectable, BadRequestException } from '@nestjs/common';

export interface BatchCreditRow {
  vintage_start: string;
  vintage_end: string;
  tonnes: number;
  project_id: string;
  methodology: string;
  serial_numbers?: string;
  metadata?: Record<string, string>;
}

export interface BatchParseResult {
  valid_rows: BatchCreditRow[];
  invalid_rows: Array<{ row: number; error: string }>;
  total_tonnes: number;
}

@Injectable()
export class BatchParserService {
  /**
   * Parse CSV format: vintage_start,vintage_end,tonnes,project_id,methodology,serial_numbers
   */
  parseCSV(csvContent: string): BatchParseResult {
    const lines = csvContent.split('\n').filter((l) => l.trim());
    if (lines.length < 2) {
      throw new BadRequestException('CSV must include header row and at least one data row');
    }

    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const required = ['vintage_start', 'vintage_end', 'tonnes', 'project_id', 'methodology'];

    const missing = required.filter((r) => !headers.includes(r));
    if (missing.length > 0) {
      throw new BadRequestException(`Missing required columns: ${missing.join(', ')}`);
    }

    const valid_rows: BatchCreditRow[] = [];
    const invalid_rows: Array<{ row: number; error: string }> = [];
    let total_tonnes = 0;

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map((v) => v.trim());
      const row: Record<string, string> = {};

      headers.forEach((h, idx) => {
        row[h] = values[idx] || '';
      });

      try {
        const parsed = this.validateRow(row, i + 1);
        valid_rows.push(parsed);
        total_tonnes += parsed.tonnes;
      } catch (error) {
        invalid_rows.push({
          row: i + 1,
          error: (error as Error).message,
        });
      }
    }

    return { valid_rows, invalid_rows, total_tonnes };
  }

  /**
   * Parse XLSX format (simpler implementation, delegates to CSV parser after conversion)
   * In production, use xlsx library for proper parsing
   */
  parseXLSX(xlsxContent: Buffer): BatchParseResult {
    // Simplified: convert to CSV first
    // In production: use xlsx.parse() and iterate rows
    throw new BadRequestException('XLSX parsing requires xlsx library installation');
  }

  /**
   * Validate a single row
   */
  private validateRow(row: Record<string, string>, rowNum: number): BatchCreditRow {
    // Validate vintage dates
    const vintage_start = row['vintage_start'];
    const vintage_end = row['vintage_end'];

    if (!this.isValidDate(vintage_start)) {
      throw new Error(`Row ${rowNum}: Invalid vintage_start date format (YYYY-MM-DD)`);
    }
    if (!this.isValidDate(vintage_end)) {
      throw new Error(`Row ${rowNum}: Invalid vintage_end date format (YYYY-MM-DD)`);
    }

    if (new Date(vintage_start) >= new Date(vintage_end)) {
      throw new Error(`Row ${rowNum}: vintage_start must be before vintage_end`);
    }

    // Validate tonnes
    const tonnes = parseFloat(row['tonnes']);
    if (isNaN(tonnes) || tonnes <= 0) {
      throw new Error(`Row ${rowNum}: tonnes must be a positive number`);
    }

    if (tonnes > 1000000) {
      throw new Error(`Row ${rowNum}: tonnes exceeds maximum (1,000,000)`);
    }

    // Validate project_id
    const project_id = row['project_id']?.trim();
    if (!project_id) {
      throw new Error(`Row ${rowNum}: project_id required`);
    }

    // Validate methodology
    const methodology = row['methodology']?.trim();
    if (!methodology) {
      throw new Error(`Row ${rowNum}: methodology required`);
    }

    const valid_methodologies = ['vcs', 'gold', 'car', 'acr'];
    if (!valid_methodologies.includes(methodology.toLowerCase())) {
      throw new Error(
        `Row ${rowNum}: methodology must be one of: ${valid_methodologies.join(', ')}`,
      );
    }

    return {
      vintage_start,
      vintage_end,
      tonnes,
      project_id,
      methodology,
      serial_numbers: row['serial_numbers'],
      metadata: this.extractMetadata(row),
    };
  }

  /**
   * Extract additional metadata columns
   */
  private extractMetadata(row: Record<string, string>): Record<string, string> | undefined {
    const standard_cols = [
      'vintage_start',
      'vintage_end',
      'tonnes',
      'project_id',
      'methodology',
      'serial_numbers',
    ];
    const metadata: Record<string, string> = {};

    Object.entries(row).forEach(([key, value]) => {
      if (!standard_cols.includes(key) && value) {
        metadata[key] = value;
      }
    });

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  /**
   * Validate date format YYYY-MM-DD
   */
  private isValidDate(dateString: string): boolean {
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(dateString)) return false;
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date.getTime());
  }
}
