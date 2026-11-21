import { Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CreditMetadata, RetirementRecord, TONNES_SCALE } from '@shared';

function toEpochMs(timestamp: number): number {
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function formatTonnes(raw: string): string {
  try {
    const big = BigInt(raw);
    const whole = big / TONNES_SCALE;
    const frac = Number(big % TONNES_SCALE) / Number(TONNES_SCALE);
    return (Number(whole) + frac).toFixed(4);
  } catch {
    return '0.0000';
  }
}

function escapeCsvCell(value: string | number | undefined | null): string {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeHtml(value: string | number | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Component({
  selector: 'app-export-receipts-button',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="export-receipts" role="region" aria-label="Export offset and tax receipts">
      <label class="export-receipts__year-label">
        <span class="sr-only">Tax year</span>
        <select
          class="export-receipts__select"
          [ngModel]="selectedYear()"
          (ngModelChange)="selectedYear.set($event)"
          aria-label="Filter receipts by tax year"
        >
          <option value="all">All Tax Years</option>
          @for (year of availableYears(); track year) {
            <option [value]="year">{{ year }}</option>
          }
        </select>
      </label>

      <button
        type="button"
        class="export-btn export-btn--csv"
        [disabled]="filteredRetirements().length === 0"
        (click)="exportCsv()"
      >
        Export CSV
      </button>

      <button
        type="button"
        class="export-btn export-btn--pdf"
        [disabled]="filteredRetirements().length === 0"
        (click)="exportPdf()"
      >
        Export PDF
      </button>

      <span class="export-receipts__meta" aria-live="polite">
        {{ filteredRetirements().length }} receipt{{
          filteredRetirements().length === 1 ? '' : 's'
        }}
        ({{ totalFilteredTonnes() | number: '1.2-4' }} t CO₂e)
      </span>
    </div>
  `,
  styles: [
    `
      .export-receipts {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        border: 0;
      }

      .export-receipts__select {
        padding: 0.45rem 0.65rem;
        border-radius: 6px;
        border: 1px solid #d1d5db;
        background: #ffffff;
        color: #111827;
        font-size: 0.85rem;
      }

      .export-btn {
        padding: 0.45rem 0.85rem;
        border-radius: 6px;
        border: 1px solid transparent;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }

      .export-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .export-btn--csv {
        background: #1976d2;
        color: #ffffff;
      }
      .export-btn--csv:hover:not(:disabled) {
        background: #1565c0;
      }

      .export-btn--pdf {
        background: #2e7d32;
        color: #ffffff;
      }
      .export-btn--pdf:hover:not(:disabled) {
        background: #1b5e20;
      }

      .export-receipts__meta {
        font-size: 0.8rem;
        color: #6b7280;
      }
    `,
  ],
})
export class ExportReceiptsButtonComponent {
  readonly retirements = input<RetirementRecord[]>([]);
  readonly credits = input<CreditMetadata[]>([]);
  readonly walletAddress = input<string | null>(null);

  readonly selectedYear = signal<string>('all');

  private readonly creditById = computed(() => {
    const map = new Map<string, CreditMetadata>();
    for (const c of this.credits()) {
      map.set(c.id, c);
    }
    return map;
  });

  readonly availableYears = computed(() => {
    const years = new Set<string>();
    for (const r of this.retirements()) {
      const yr = new Date(toEpochMs(r.retired_at)).getUTCFullYear();
      if (Number.isFinite(yr)) {
        years.add(String(yr));
      }
    }
    return Array.from(years).sort((a, b) => Number(b) - Number(a));
  });

  readonly filteredRetirements = computed(() => {
    const yr = this.selectedYear();
    const list = this.retirements();
    if (yr === 'all') return list;
    return list.filter(
      (r) => String(new Date(toEpochMs(r.retired_at)).getUTCFullYear()) === yr,
    );
  });

  readonly totalFilteredTonnes = computed(() => {
    let total = 0n;
    for (const r of this.filteredRetirements()) {
      try {
        total += BigInt(r.tonnes_retired);
      } catch {
        /* ignore malformed */
      }
    }
    return Number(total) / Number(TONNES_SCALE);
  });

  exportCsv(): void {
    const rows = this.filteredRetirements();
    if (rows.length === 0) return;

    const headers = [
      'Receipt ID',
      'Credit ID',
      'Retired At (UTC)',
      'Tax Year',
      'Tonnes Retired (t CO2e)',
      'Methodology',
      'Vintage Year',
      'Reason',
      'Transaction Hash',
      'Ledger Sequence',
      'Certificate IPFS Hash',
    ];

    const creditMap = this.creditById();
    const lines = [headers.map(escapeCsvCell).join(',')];

    for (const r of rows) {
      const d = new Date(toEpochMs(r.retired_at));
      const credit = creditMap.get(r.credit_id);
      lines.push(
        [
          r.id,
          r.credit_id,
          d.toISOString(),
          d.getUTCFullYear(),
          formatTonnes(r.tonnes_retired),
          credit?.methodology ?? '',
          r.vintage_year ?? credit?.vintage_year ?? '',
          r.reason,
          r.tx_hash,
          r.ledger_seq ?? '',
          r.certificate_ipfs_hash ?? '',
        ]
          .map(escapeCsvCell)
          .join(','),
      );
    }

    const csv = lines.join('\r\n');
    const yearSuffix = this.selectedYear() === 'all' ? 'all-years' : this.selectedYear();
    this.triggerDownload(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
      `carbonchain-offset-receipts-${yearSuffix}.csv`,
    );
  }

  exportPdf(): void {
    const rows = this.filteredRetirements();
    if (rows.length === 0) return;

    const yearLabel = this.selectedYear() === 'all' ? 'All Years' : this.selectedYear();
    const totalTonnes = this.totalFilteredTonnes().toFixed(4);
    const creditMap = this.creditById();
    const wallet = this.walletAddress() ?? 'N/A';

    const tableRows = rows
      .map((r) => {
        const d = new Date(toEpochMs(r.retired_at)).toISOString().slice(0, 10);
        const credit = creditMap.get(r.credit_id);
        return `<tr>
          <td>${escapeHtml(r.id)}</td>
          <td>${escapeHtml(d)}</td>
          <td>${escapeHtml(r.credit_id)}</td>
          <td>${escapeHtml(credit?.methodology ?? '—')}</td>
          <td>${escapeHtml(formatTonnes(r.tonnes_retired))}</td>
          <td>${escapeHtml(r.reason)}</td>
          <td><code>${escapeHtml(r.tx_hash)}</code></td>
        </tr>`;
      })
      .join('');

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>CarbonChain Offset &amp; Tax Deduction Summary (${escapeHtml(yearLabel)})</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; color: #111827; padding: 2rem; }
    h1 { margin: 0 0 0.25rem; font-size: 1.4rem; }
    .meta { color: #4b5563; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .summary { background: #f3f4f6; padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { border: 1px solid #d1d5db; padding: 0.5rem; text-align: left; }
    th { background: #f9fafb; }
    code { font-size: 0.75rem; word-break: break-all; }
  </style>
</head>
<body>
  <h1>CarbonChain — Carbon Offset &amp; Tax Deduction Receipt Summary</h1>
  <div class="meta">
    <div><strong>Wallet Address:</strong> <code>${escapeHtml(wallet)}</code></div>
    <div><strong>Tax Year:</strong> ${escapeHtml(yearLabel)}</div>
    <div><strong>Generated (UTC):</strong> ${escapeHtml(new Date().toISOString())}</div>
  </div>
  <div class="summary">
    <strong>Total Retired:</strong> ${escapeHtml(totalTonnes)} t CO₂e across ${rows.length} retirement(s)
  </div>
  <table>
    <thead>
      <tr>
        <th>Receipt ID</th>
        <th>Date (UTC)</th>
        <th>Credit ID</th>
        <th>Methodology</th>
        <th>Tonnes (t CO₂e)</th>
        <th>Reason</th>
        <th>Stellar Tx Hash</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;

    const printWindow = typeof window !== 'undefined' ? window.open('', '_blank', 'noopener') : null;
    if (printWindow) {
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
      return;
    }

    const yearSuffix = this.selectedYear() === 'all' ? 'all-years' : this.selectedYear();
    this.triggerDownload(
      new Blob([html], { type: 'text/html;charset=utf-8;' }),
      `carbonchain-offset-summary-${yearSuffix}.html`,
    );
  }

  private triggerDownload(blob: Blob, filename: string): void {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
