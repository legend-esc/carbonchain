import {
  Component,
  Input,
  signal,
  computed,
  OnChanges,
  AfterViewInit,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RetirementRecord, TONNES_SCALE } from '@shared';

// ── Types ──────────────────────────────────────────────────────────────────

interface TimelineBar {
  vintageYear: number;
  methodology: string;
  tonnes: number;
  retiredAt: number; // unix ms
  /** 0–100 relative height within the chart */
  heightPct: number;
  /** left offset as percentage of chart width */
  xPct: number;
  /** bar width as percentage of chart width */
  widthPct: number;
  color: string;
}

interface TooltipData {
  vintageYear: number;
  methodology: string;
  tonnes: number;
  retiredAt: number;
  x: number;
  y: number;
}

interface StackedGroup {
  vintageYear: number;
  totalTonnes: number;
  bars: TimelineBar[];
}

const METHODOLOGY_COLORS: Record<string, string> = {
  'REDD+': '#388e3c',
  VCS: '#1976d2',
  'Gold Standard': '#f57c00',
  CDM: '#7b1fa2',
  'Plan Vivo': '#c62828',
};

const FALLBACK_COLORS = ['#00838f', '#558b2f', '#4527a0', '#ad1457', '#37474f'];

function methodologyColor(method: string, seen: Map<string, string>): string {
  if (METHODOLOGY_COLORS[method]) return METHODOLOGY_COLORS[method];
  if (!seen.has(method)) {
    seen.set(method, FALLBACK_COLORS[seen.size % FALLBACK_COLORS.length]);
  }
  return seen.get(method)!;
}

function rawToTonnes(raw: string): number {
  try {
    const big = BigInt(raw);
    const whole = big / TONNES_SCALE;
    const frac = Number(big % TONNES_SCALE) / Number(TONNES_SCALE);
    return Number(whole) + frac;
  } catch {
    return 0;
  }
}

/** #1326 — Stacked bar chart showing retired tonnes grouped by vintage year. */
@Component({
  selector: 'app-offset-timeline',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="timeline-section" aria-labelledby="timeline-title">
      <h2 id="timeline-title" class="timeline-heading">Carbon Offset Timeline</h2>
      <p class="timeline-sub">Retired tonnes by vintage year and project methodology</p>

      @if (retirements.length === 0) {
        <!-- Empty state illustration -->
        <div class="empty-state" role="status" aria-label="No retirement history">
          <svg
            class="empty-svg"
            viewBox="0 0 200 160"
            aria-hidden="true"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect x="20" y="80" width="30" height="60" rx="4" fill="#c8e6c9" opacity="0.6" />
            <rect x="60" y="60" width="30" height="80" rx="4" fill="#c8e6c9" opacity="0.4" />
            <rect x="100" y="40" width="30" height="100" rx="4" fill="#c8e6c9" opacity="0.3" />
            <rect x="140" y="70" width="30" height="70" rx="4" fill="#c8e6c9" opacity="0.5" />
            <line x1="10" y1="140" x2="190" y2="140" stroke="#aaa" stroke-width="2" />
            <text x="100" y="158" text-anchor="middle" font-size="10" fill="#888">
              No retirements yet
            </text>
          </svg>
          <p class="empty-msg">
            You haven't retired any credits yet. Retire credits to see your offset timeline here.
          </p>
        </div>
      } @else {
        <!-- Chart SVG -->
        <div class="chart-wrap" (mouseleave)="clearTooltip()">
          <svg
            class="timeline-svg"
            [attr.viewBox]="'0 0 ' + SVG_W + ' ' + SVG_H"
            [attr.width]="SVG_W"
            [attr.height]="SVG_H"
            role="img"
            aria-label="Stacked bar chart of carbon credit retirements by vintage year"
          >
            <title>Carbon offset timeline — retired tonnes by vintage year</title>

            <!-- Y-axis grid lines -->
            @for (tick of yTicks(); track tick.y) {
              <line
                [attr.x1]="PADDING_LEFT"
                [attr.y1]="tick.y"
                [attr.x2]="SVG_W - PADDING_RIGHT"
                [attr.y2]="tick.y"
                stroke="#e0e0e0"
                stroke-width="1"
              />
              <text
                [attr.x]="PADDING_LEFT - 6"
                [attr.y]="tick.y + 4"
                text-anchor="end"
                class="axis-label"
              >
                {{ tick.label }}
              </text>
            }

            <!-- Stacked bars per vintage year -->
            @for (group of groups(); track group.vintageYear) {
              @for (bar of group.bars; track bar.methodology) {
                <rect
                  [attr.x]="barX(group)"
                  [attr.y]="barTopY(bar, group)"
                  [attr.width]="barW()"
                  [attr.height]="barH(bar)"
                  [attr.fill]="bar.color"
                  rx="3"
                  class="bar-rect"
                  (mouseenter)="showTooltip(bar, group, $event)"
                  (focus)="showTooltip(bar, group, $event)"
                  tabindex="0"
                  role="graphics-symbol"
                  [attr.aria-label]="
                    group.vintageYear +
                    ' ' +
                    bar.methodology +
                    ': ' +
                    bar.tonnes.toFixed(2) +
                    ' t CO₂e'
                  "
                />
              }
              <!-- X-axis label -->
              <text
                [attr.x]="barX(group) + barW() / 2"
                [attr.y]="SVG_H - PADDING_BOTTOM + 14"
                text-anchor="middle"
                class="axis-label"
              >
                {{ group.vintageYear }}
              </text>
            }

            <!-- X axis line -->
            <line
              [attr.x1]="PADDING_LEFT"
              [attr.y1]="SVG_H - PADDING_BOTTOM"
              [attr.x2]="SVG_W - PADDING_RIGHT"
              [attr.y2]="SVG_H - PADDING_BOTTOM"
              stroke="#aaa"
              stroke-width="1.5"
            />

            <!-- Y axis line -->
            <line
              [attr.x1]="PADDING_LEFT"
              [attr.y1]="PADDING_TOP"
              [attr.x2]="PADDING_LEFT"
              [attr.y2]="SVG_H - PADDING_BOTTOM"
              stroke="#aaa"
              stroke-width="1.5"
            />

            <!-- Y-axis unit label -->
            <text
              [attr.x]="8"
              [attr.y]="SVG_H / 2"
              text-anchor="middle"
              class="axis-unit"
              [attr.transform]="'rotate(-90, 8, ' + SVG_H / 2 + ')'"
            >
              t CO₂e
            </text>
          </svg>

          <!-- Tooltip (HTML overlay — simpler than SVG foreignObject) -->
          @if (tooltip()) {
            <div
              class="tooltip"
              [style.left.px]="tooltip()!.x + 12"
              [style.top.px]="tooltip()!.y - 20"
              role="tooltip"
            >
              <div class="tt-row"><strong>Vintage</strong> {{ tooltip()!.vintageYear }}</div>
              <div class="tt-row"><strong>Methodology</strong> {{ tooltip()!.methodology }}</div>
              <div class="tt-row">
                <strong>Tonnes</strong> {{ tooltip()!.tonnes | number: '1.2-2' }} t CO₂e
              </div>
              <div class="tt-row">
                <strong>Retired</strong>
                {{ tooltip()!.retiredAt | date: 'mediumDate' }}
              </div>
            </div>
          }
        </div>

        <!-- Legend -->
        <ul class="legend" aria-label="Methodology legend">
          @for (item of legendItems(); track item.label) {
            <li class="legend-item">
              <span class="legend-swatch" [style.background]="item.color"></span>
              {{ item.label }}
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    `
      .timeline-section {
        background: var(--surface, #f9f9f9);
        border: 1px solid var(--border, #e0e0e0);
        border-radius: 8px;
        padding: 1.25rem;
        margin-bottom: 1.5rem;
        overflow-x: auto;
      }

      .timeline-heading {
        margin: 0 0 0.25rem;
        font-size: 1rem;
        color: var(--text, #1a1a2e);
      }

      .timeline-sub {
        margin: 0 0 1rem;
        font-size: 0.8rem;
        color: var(--text-muted, #555);
      }

      /* Empty state */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        padding: 2rem 0;
      }

      .empty-svg {
        width: 160px;
        height: auto;
      }

      .empty-msg {
        max-width: 320px;
        text-align: center;
        color: var(--text-muted, #666);
        font-size: 0.875rem;
        margin: 0;
      }

      /* Chart */
      .chart-wrap {
        position: relative;
        display: inline-block;
      }

      .timeline-svg {
        display: block;
        overflow: visible;
      }

      .bar-rect {
        cursor: pointer;
        transition: opacity 0.1s;
      }

      .bar-rect:hover,
      .bar-rect:focus {
        opacity: 0.75;
        outline: 2px solid var(--accent, #4caf50);
      }

      .axis-label {
        font-size: 10px;
        fill: var(--text-muted, #666);
      }

      .axis-unit {
        font-size: 9px;
        fill: var(--text-muted, #888);
      }

      /* Tooltip */
      .tooltip {
        position: absolute;
        background: rgba(26, 26, 46, 0.92);
        color: #fff;
        border-radius: 6px;
        padding: 0.5rem 0.75rem;
        font-size: 0.8rem;
        pointer-events: none;
        z-index: 10;
        white-space: nowrap;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      }

      .tt-row {
        display: flex;
        gap: 0.4rem;
        margin-bottom: 0.15rem;
      }

      .tt-row:last-child {
        margin-bottom: 0;
      }

      /* Legend */
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem 1.25rem;
        list-style: none;
        margin: 0.75rem 0 0;
        padding: 0;
      }

      .legend-item {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.8rem;
        color: var(--text, #1a1a2e);
      }

      .legend-swatch {
        width: 12px;
        height: 12px;
        border-radius: 2px;
        flex-shrink: 0;
      }
    `,
  ],
})
export class OffsetTimelineComponent implements OnChanges, AfterViewInit {
  @Input() retirements: RetirementRecord[] = [];

  // SVG constants
  readonly SVG_W = 560;
  readonly SVG_H = 260;
  readonly PADDING_LEFT = 44;
  readonly PADDING_RIGHT = 16;
  readonly PADDING_TOP = 20;
  readonly PADDING_BOTTOM = 28;

  private readonly _groups = signal<StackedGroup[]>([]);
  readonly tooltip = signal<TooltipData | null>(null);

  readonly groups = this._groups.asReadonly();

  private colorMap = new Map<string, string>();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['retirements']) {
      this.buildGroups();
    }
  }

  ngAfterViewInit(): void {
    // Ensure groups are built when retirements is set directly (e.g. in unit tests
    // where ngOnChanges may not fire because the property was set before compilation).
    if (this._groups().length === 0 && this.retirements.length > 0) {
      this.buildGroups();
    }
  }

  private buildGroups(): void {
    this.colorMap = new Map();
    const byYear = new Map<number, RetirementRecord[]>();

    for (const r of this.retirements) {
      const year = r.vintage_year ?? new Date(r.retired_at * 1000).getFullYear();
      const list = byYear.get(year) ?? [];
      list.push(r);
      byYear.set(year, list);
    }

    const maxTonnes = Math.max(
      ...Array.from(byYear.values()).map((recs) =>
        recs.reduce((s, r) => s + rawToTonnes(r.tonnes_retired), 0),
      ),
      0.001,
    );

    const groups: StackedGroup[] = Array.from(byYear.entries())
      .sort(([a], [b]) => a - b)
      .map(([vintageYear, recs]) => {
        const totalTonnes = recs.reduce((s, r) => s + rawToTonnes(r.tonnes_retired), 0);
        // Group records by methodology to stack them
        const byMethod = new Map<string, number>();
        for (const r of recs) {
          const m = r.reason?.split(':')[0]?.trim() || 'Unknown';
          byMethod.set(m, (byMethod.get(m) ?? 0) + rawToTonnes(r.tonnes_retired));
        }
        const bars: TimelineBar[] = Array.from(byMethod.entries()).map(([method, tonnes]) => ({
          vintageYear,
          methodology: method,
          tonnes,
          retiredAt: (recs.find(() => true)?.retired_at ?? 0) * 1000,
          heightPct: (tonnes / maxTonnes) * 100,
          xPct: 0,
          widthPct: 0,
          color: methodologyColor(method, this.colorMap),
        }));
        return { vintageYear, totalTonnes, bars };
      });

    this._groups.set(groups);
  }

  readonly legendItems = computed(() => {
    const seen = new Set<string>();
    const items: { label: string; color: string }[] = [];
    for (const g of this._groups()) {
      for (const b of g.bars) {
        if (!seen.has(b.methodology)) {
          seen.add(b.methodology);
          items.push({ label: b.methodology, color: b.color });
        }
      }
    }
    return items;
  });

  // ── Geometry helpers ──────────────────────────────────────────────────────

  private get plotW(): number {
    return this.SVG_W - this.PADDING_LEFT - this.PADDING_RIGHT;
  }

  private get plotH(): number {
    return this.SVG_H - this.PADDING_TOP - this.PADDING_BOTTOM;
  }

  barW(): number {
    const count = Math.max(this._groups().length, 1);
    return Math.min((this.plotW / count) * 0.7, 60);
  }

  barX(group: StackedGroup): number {
    const count = this._groups().length;
    const idx = this._groups().indexOf(group);
    const slotW = this.plotW / count;
    return this.PADDING_LEFT + idx * slotW + (slotW - this.barW()) / 2;
  }

  private maxGroupTonnes(): number {
    return Math.max(...this._groups().map((g) => g.totalTonnes), 0.001);
  }

  barH(bar: TimelineBar): number {
    return (bar.tonnes / this.maxGroupTonnes()) * this.plotH;
  }

  barTopY(bar: TimelineBar, group: StackedGroup): number {
    // Bars stack from the base up; compute cumulative height up to this bar
    const idx = group.bars.indexOf(bar);
    const above = group.bars.slice(0, idx).reduce((s, b) => s + this.barH(b), 0);
    const totalH = this.barH(bar) + above;
    return this.SVG_H - this.PADDING_BOTTOM - totalH;
  }

  readonly yTicks = computed(() => {
    const max = this.maxGroupTonnes();
    const step = max / 4;
    return Array.from({ length: 5 }, (_, i) => {
      const val = step * i;
      const y = this.SVG_H - this.PADDING_BOTTOM - (val / max) * this.plotH;
      return { y, label: val < 1 ? val.toFixed(1) : val.toFixed(0) };
    });
  });

  showTooltip(bar: TimelineBar, group: StackedGroup, event: MouseEvent | FocusEvent): void {
    const rect = (event.currentTarget as Element).closest('.chart-wrap')?.getBoundingClientRect();
    const target = (event.currentTarget as Element).getBoundingClientRect();
    const x = target.left - (rect?.left ?? 0) + this.barW() / 2;
    const y = target.top - (rect?.top ?? 0);
    this.tooltip.set({
      vintageYear: group.vintageYear,
      methodology: bar.methodology,
      tonnes: bar.tonnes,
      retiredAt: bar.retiredAt,
      x,
      y,
    });
  }

  clearTooltip(): void {
    this.tooltip.set(null);
  }
}
