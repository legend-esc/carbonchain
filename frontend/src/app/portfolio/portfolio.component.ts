import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CreditMetadata, CreditStatus, RetirementRecord, TONNES_SCALE } from '@shared';
import { CreditStore } from '../core/store/credit.store';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ApiService } from '../core/services/api.service';

// ── Chart helpers ─────────────────────────────────────────────────────────────

interface BarDatum {
  label: string;
  value: number;
  pct: number; // 0–100 relative to max bar
}

interface PieDatum {
  label: string;
  value: number;
  /** Normalised share 0–1 */
  share: number;
  /** SVG arc start angle in degrees */
  startAngle: number;
  /** SVG arc end angle in degrees */
  endAngle: number;
  /** Hex colour */
  color: string;
}

/** Palette for up to 10 slices; cycles if more. */
const CHART_COLORS = [
  '#1976d2', '#388e3c', '#f57c00', '#7b1fa2',
  '#c62828', '#00838f', '#558b2f', '#4527a0',
  '#ad1457', '#37474f',
];

/**
 * Convert BigInt-as-string tonnes units to a human-readable CO₂e tonne value
 * using integer-safe BigInt arithmetic.
 */
function toTonnesBigInt(raw: string): bigint {
  try {
    return BigInt(raw) / TONNES_SCALE;
  } catch {
    return 0n;
  }
}

function toTonnesNumber(raw: string): number {
  try {
    // Divide by TONNES_SCALE using integer part + fractional part to avoid
    // floating-point issues with very large BigInt values.
    const big = BigInt(raw);
    const whole = big / TONNES_SCALE;
    const frac = Number(big % TONNES_SCALE) / Number(TONNES_SCALE);
    return Number(whole) + frac;
  } catch {
    return 0;
  }
}

function buildBarChart(data: Record<string, number>): BarDatum[] {
  const entries = Object.entries(data).sort((a, b) => Number(b[1]) - Number(a[1]));
  const max = entries.length > 0 ? entries[0][1] : 1;
  return entries.map(([label, value]) => ({
    label,
    value,
    pct: max > 0 ? (value / max) * 100 : 0,
  }));
}

function buildPieChart(data: Record<string, number>): PieDatum[] {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let cursor = 0;
  return entries.map(([label, value], i) => {
    const share = total > 0 ? value / total : 0;
    const startAngle = cursor * 360;
    cursor += share;
    return {
      label,
      value,
      share,
      startAngle,
      endAngle: cursor * 360,
      color: CHART_COLORS[i % CHART_COLORS.length],
    };
  });
}

/**
 * Compute an SVG arc path for a pie slice.
 *
 * @param cx     Centre x
 * @param cy     Centre y
 * @param r      Radius
 * @param start  Start angle in degrees (0 = top)
 * @param end    End angle in degrees
 */
function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const toRad = (d: number): number => ((d - 90) * Math.PI) / 180;
  const sx = cx + r * Math.cos(toRad(start));
  const sy = cy + r * Math.sin(toRad(start));
  const ex = cx + r * Math.cos(toRad(end));
  const ey = cy + r * Math.sin(toRad(end));
  const large = end - start > 180 ? 1 : 0;
  // If it's a full circle, draw two arcs to avoid degenerate path
  if (end - start >= 359.999) {
    const mid = cx + r * Math.cos(toRad(start + 180));
    const my = cy + r * Math.sin(toRad(start + 180));
    return `M ${sx} ${sy} A ${r} ${r} 0 1 1 ${mid} ${my} A ${r} ${r} 0 1 1 ${sx} ${sy} Z`;
  }
  return `M ${cx} ${cy} L ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} Z`;
}

@Component({
  selector: 'app-portfolio',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <div class="portfolio">
      <h1>Portfolio Analytics</h1>

      @if (!wallet.publicKey()) {
        <p class="status">Connect your wallet to view your portfolio analytics.</p>
      } @else if (loading()) {
        <p class="status">Loading portfolio data…</p>
      } @else if (loadError()) {
        <p class="alert alert--error">{{ loadError() }}</p>
      } @else {
        <!-- Summary Cards -->
        <section class="summary-grid" aria-label="Portfolio summary">
          <div class="summary-card">
            <span class="summary-label">Total Holdings</span>
            <span class="summary-value">{{ totalHoldingsTonnes() | number: '1.4-4' }} t CO₂e</span>
            <span class="summary-sub">{{ activeCreditsCount() }} active credit{{ activeCreditsCount() !== 1 ? 's' : '' }}</span>
          </div>
          <div class="summary-card summary-card--retired">
            <span class="summary-label">Total Retired</span>
            <span class="summary-value">{{ totalRetiredTonnes() | number: '1.4-4' }} t CO₂e</span>
            <span class="summary-sub">{{ retiredCreditsCount() }} retired credit{{ retiredCreditsCount() !== 1 ? 's' : '' }}</span>
          </div>
          <div class="summary-card summary-card--neutral">
            <span class="summary-label">Net Balance</span>
            <span class="summary-value">{{ netBalanceTonnes() | number: '1.4-4' }} t CO₂e</span>
            <span class="summary-sub">Holdings minus retired</span>
          </div>
        </section>

        <!-- Vintage Year Histogram -->
        <section class="card chart-card" aria-label="Vintage year distribution">
          <h2>Vintage Year Distribution (Active Credits)</h2>
          @if (vintageBarData().length === 0) {
            <p class="status">No active credits to chart.</p>
          } @else {
            <svg
              class="bar-chart"
              [attr.width]="barChartWidth"
              [attr.height]="barChartHeight"
              role="img"
              aria-label="Vintage year bar chart"
            >
              <title>Active credit holdings by vintage year (t CO₂e)</title>
              @for (bar of vintageBarData(); track bar.label; let i = $index) {
                <g
                  [attr.transform]="'translate(' + barX(i) + ', 0)'"
                  role="graphics-symbol"
                  [attr.aria-label]="bar.label + ': ' + bar.value.toFixed(4) + ' t'"
                >
                  <!-- Bar fill -->
                  <rect
                    [attr.x]="0"
                    [attr.y]="barY(bar.pct)"
                    [attr.width]="barWidth - barGap"
                    [attr.height]="barChartHeight - barPaddingBottom - barY(bar.pct)"
                    fill="#1976d2"
                    rx="3"
                  />
                  <!-- Year label below -->
                  <text
                    [attr.x]="(barWidth - barGap) / 2"
                    [attr.y]="barChartHeight - barPaddingBottom + 14"
                    text-anchor="middle"
                    class="bar-label"
                  >{{ bar.label }}</text>
                  <!-- Value above bar -->
                  <text
                    [attr.x]="(barWidth - barGap) / 2"
                    [attr.y]="barY(bar.pct) - 4"
                    text-anchor="middle"
                    class="bar-value"
                  >{{ bar.value < 1 ? bar.value.toFixed(2) : bar.value.toFixed(0) }}</text>
                </g>
              }
              <!-- Y-axis label -->
              <text
                x="-4"
                [attr.y]="barChartHeight / 2"
                text-anchor="middle"
                class="axis-label"
                transform="rotate(-90, -4, 152)"
              >t CO₂e</text>
            </svg>
          }
        </section>

        <!-- Methodology Distribution -->
        <section class="card chart-card" aria-label="Methodology distribution">
          <h2>Methodology Distribution (All Credits)</h2>
          @if (methodologyPieData().length === 0) {
            <p class="status">No credits to chart.</p>
          } @else {
            <div class="pie-layout">
              <svg
                [attr.width]="pieSize"
                [attr.height]="pieSize"
                role="img"
                aria-label="Methodology distribution pie chart"
              >
                <title>Credit methodology distribution by tonnes</title>
                @for (slice of methodologyPieData(); track slice.label) {
                  <path
                    [attr.d]="slicePath(slice)"
                    [attr.fill]="slice.color"
                    stroke="#fff"
                    stroke-width="1.5"
                    role="graphics-symbol"
                    [attr.aria-label]="slice.label + ': ' + (slice.share * 100).toFixed(1) + '%'"
                  >
                    <title>{{ slice.label }}: {{ (slice.share * 100).toFixed(1) }}% ({{ slice.value.toFixed(4) }} t)</title>
                  </path>
                }
              </svg>
              <!-- Legend -->
              <ul class="pie-legend" aria-label="Methodology legend">
                @for (slice of methodologyPieData(); track slice.label) {
                  <li class="pie-legend-item">
                    <span class="legend-swatch" [style.background]="slice.color"></span>
                    <span class="legend-label">{{ slice.label }}</span>
                    <span class="legend-pct">{{ (slice.share * 100).toFixed(1) }}%</span>
                    <span class="legend-val">({{ slice.value.toFixed(4) }} t)</span>
                  </li>
                }
              </ul>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .portfolio {
      max-width: 900px;
      margin: 0 auto;
      padding: 0 1rem;
    }
    h1 { margin: 0 0 1.5rem; }
    h2 { margin: 0 0 1rem; font-size: 1rem; color: #444; }
    .status { color: #888; }
    .alert { padding: 0.75rem 1rem; border-radius: 6px; font-size: 0.875rem; }
    .alert--error { background: #ffebee; color: #c62828; border: 1px solid #ef9a9a; }

    /* Summary cards */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .summary-card {
      background: #e3f2fd;
      border: 1px solid #90caf9;
      border-radius: 8px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .summary-card--retired { background: #ede7f6; border-color: #ce93d8; }
    .summary-card--neutral { background: #e8f5e9; border-color: #a5d6a7; }
    .summary-label { font-size: 0.75rem; font-weight: 600; color: #555; text-transform: uppercase; }
    .summary-value { font-size: 1.5rem; font-weight: 700; color: #1a1a1a; }
    .summary-sub { font-size: 0.8rem; color: #666; }

    /* Chart cards */
    .card { background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.25rem; }
    .chart-card { overflow-x: auto; }

    /* Bar chart */
    .bar-chart { display: block; overflow: visible; }
    .bar-label { font-size: 10px; fill: #555; }
    .bar-value { font-size: 9px; fill: #333; }
    .axis-label { font-size: 9px; fill: #666; }

    /* Pie chart */
    .pie-layout { display: flex; align-items: flex-start; gap: 2rem; flex-wrap: wrap; }
    .pie-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
    .pie-legend-item { display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; }
    .legend-swatch { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }
    .legend-label { flex: 1; }
    .legend-pct { font-weight: 600; min-width: 40px; text-align: right; }
    .legend-val { color: #666; font-size: 0.8rem; min-width: 80px; }
  `],
})
export class PortfolioComponent implements OnInit {
  protected readonly wallet = inject(StellarWalletService);
  protected readonly store = inject(CreditStore);
  private readonly api = inject(ApiService);

  // ── State ──────────────────────────────────────────────────────────────────

  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly retirements = signal<RetirementRecord[]>([]);

  // ── Chart config constants ─────────────────────────────────────────────────

  readonly barChartWidth = 560;
  readonly barChartHeight = 220;
  readonly barPaddingBottom = 24;
  readonly barPaddingTop = 24;
  readonly barGap = 4;

  // ── Computed analytics ─────────────────────────────────────────────────────

  /** Total active holdings in CO₂e tonnes (BigInt-safe). */
  readonly totalHoldingsTonnes = computed(() => {
    const credits = this.store.activeCredits();
    let total = 0n;
    for (const c of credits) {
      try { total += BigInt(c.tonnes); } catch { /* skip malformed */ }
    }
    return Number(total) / Number(TONNES_SCALE);
  });

  readonly activeCreditsCount = computed(() => this.store.activeCredits().length);
  readonly retiredCreditsCount = computed(() => this.store.retiredCredits().length);

  /** Total retired CO₂e tonnes from retirement records. */
  readonly totalRetiredTonnes = computed(() => {
    let total = 0n;
    for (const r of this.retirements()) {
      try { total += BigInt(r.tonnes_retired); } catch { /* skip */ }
    }
    return Number(total) / Number(TONNES_SCALE);
  });

  /** Net balance = holdings - retired. */
  readonly netBalanceTonnes = computed(
    () => this.totalHoldingsTonnes() - this.totalRetiredTonnes(),
  );

  /** Bar chart data: vintage year → total active tonnes. */
  readonly vintageBarData = computed((): BarDatum[] => {
    const byYear: Record<string, number> = {};
    for (const c of this.store.activeCredits()) {
      const key = String(c.vintage_year);
      byYear[key] = (byYear[key] ?? 0) + toTonnesNumber(c.tonnes);
    }
    return buildBarChart(byYear);
  });

  /** Number of bars for bar chart width calculations. */
  readonly barCount = computed(() => Math.max(this.vintageBarData().length, 1));

  /** Pie chart data: methodology → total tonnes (all credits). */
  readonly methodologyPieData = computed((): PieDatum[] => {
    const byMethod: Record<string, number> = {};
    for (const c of this.store.credits()) {
      const key = c.methodology || 'Unknown';
      byMethod[key] = (byMethod[key] ?? 0) + toTonnesNumber(c.tonnes);
    }
    return buildPieChart(byMethod);
  });

  // ── Bar chart geometry ─────────────────────────────────────────────────────

  get barWidth(): number {
    return this.barChartWidth / Math.max(this.barCount(), 1);
  }

  barX(i: number): number {
    return i * this.barWidth;
  }

  barY(pct: number): number {
    const plotHeight = this.barChartHeight - this.barPaddingBottom - this.barPaddingTop;
    return this.barPaddingTop + plotHeight * (1 - pct / 100);
  }

  // ── Pie chart geometry ─────────────────────────────────────────────────────

  readonly pieSize = 200;

  slicePath(slice: PieDatum): string {
    const cx = this.pieSize / 2;
    const cy = this.pieSize / 2;
    const r = this.pieSize / 2 - 4;
    return arcPath(cx, cy, r, slice.startAngle, slice.endAngle);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    const pk = this.wallet.publicKey();
    if (!pk) return;
    this.loading.set(true);
    this.loadError.set(null);
    try {
      await this.store.loadByProject(pk);
      await this.loadRetirements();
    } catch (err) {
      this.loadError.set(err instanceof Error ? err.message : 'Failed to load portfolio data.');
    } finally {
      this.loading.set(false);
    }
  }

  private async loadRetirements(): Promise<void> {
    const retiredCredits = this.store.retiredCredits();
    if (retiredCredits.length === 0) return;
    const records = await Promise.all(
      retiredCredits.map((c) =>
        firstValueFrom(this.api.getRetirement(c.id)).catch(() => null),
      ),
    );
    this.retirements.set(records.filter((r): r is RetirementRecord => r !== null));
  }
}
