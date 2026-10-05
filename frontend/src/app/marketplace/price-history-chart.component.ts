import { Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import { type PricePoint } from '../core/store/market-events.store';

/**
 * Issue #958 — project-level price history.
 *
 * Hand-rolled SVG rather than a charting dependency: the existing portfolio
 * charts are already inline SVG, and the brief asks for something that stays
 * within "Angular primitives or the existing canvas usage". Rendering into a
 * `<canvas>` would also work, but SVG keeps the points reachable by assistive
 * tech, which the a11y pass (#963) needs.
 */
@Component({
  selector: 'app-price-history-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <figure class="chart">
      <figcaption class="chart__caption">
        Price history
        @if (projectLabel()) {
          <span class="chart__project">— {{ projectLabel() }}</span>
        }
      </figcaption>

      @if (points().length === 0) {
        <p class="chart__empty">
          No price history yet. Listings and price changes appear here as they happen.
        </p>
      } @else {
        <svg
          class="chart__svg"
          [attr.width]="width"
          [attr.height]="height"
          [attr.viewBox]="'0 0 ' + width + ' ' + height"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          [attr.aria-label]="summary()"
        >
          <title>{{ summary() }}</title>
          <desc>{{ describeSeries() }}</desc>

          <!-- Horizontal gridlines + y labels -->
          @for (line of gridLines(); track line.value) {
            <g>
              <line
                [attr.x1]="padding.left"
                [attr.x2]="width - padding.right"
                [attr.y1]="line.y"
                [attr.y2]="line.y"
                class="chart__grid"
              />
              <text
                [attr.x]="padding.left - 6"
                [attr.y]="line.y + 3"
                text-anchor="end"
                class="chart__axis-label"
              >
                {{ line.label }}
              </text>
            </g>
          }

          <!-- Area under the line -->
          <path [attr.d]="areaPath()" class="chart__area" />

          <!-- Price line -->
          <path [attr.d]="linePath()" class="chart__line" />

          <!-- Data points, each individually labelled for screen readers -->
          @for (point of plotted(); track point.event.id) {
            <circle
              [attr.cx]="point.cx"
              [attr.cy]="point.cy"
              r="4"
              class="chart__point"
              role="graphics-symbol"
              [attr.aria-label]="pointLabel(point)"
            >
              <title>{{ pointLabel(point) }}</title>
            </circle>
          }

          <!-- X axis labels: first and last only, to avoid overlap -->
          <text
            [attr.x]="padding.left"
            [attr.y]="height - 6"
            text-anchor="start"
            class="chart__axis-label"
          >
            {{ firstDate() }}
          </text>
          <text
            [attr.x]="width - padding.right"
            [attr.y]="height - 6"
            text-anchor="end"
            class="chart__axis-label"
          >
            {{ lastDate() }}
          </text>
        </svg>

        <p class="chart__latest" role="status">
          Latest: {{ formatPrice(latestPrice()) }}
          @if (delta() !== null) {
            <span [class.chart__delta--up]="delta()! > 0" [class.chart__delta--down]="delta()! < 0">
              ({{ delta()! > 0 ? '+' : '' }}{{ formatPrice(delta()!) }} vs first)
            </span>
          }
        </p>
      }
    </figure>
  `,
  styles: [
    `
      .chart {
        margin: 0 0 1.25rem;
      }
      .chart__caption {
        font-size: 0.95rem;
        font-weight: 600;
        color: #1a1a1a;
        margin-bottom: 0.5rem;
      }
      .chart__project {
        font-weight: 400;
        color: #4a4a4a;
      }
      .chart__empty {
        color: #595959;
        font-size: 0.85rem;
        margin: 0;
      }
      .chart__svg {
        display: block;
        max-width: 100%;
        height: auto;
      }
      .chart__grid {
        stroke: #e0e0e0;
        stroke-width: 1;
      }
      .chart__axis-label {
        font-size: 10px;
        fill: #404040;
      }
      .chart__line {
        fill: none;
        stroke: #1565c0;
        stroke-width: 2;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      .chart__area {
        fill: rgba(21, 101, 192, 0.12);
        stroke: none;
      }
      .chart__point {
        fill: #1565c0;
        stroke: #fff;
        stroke-width: 1.5;
      }
      .chart__point:focus-visible {
        outline: 3px solid #0d47a1;
        outline-offset: 2px;
      }
      .chart__latest {
        font-size: 0.85rem;
        color: #1a1a1a;
        margin: 0.5rem 0 0;
        font-weight: 500;
      }
      .chart__delta--up {
        color: #a31515;
      }
      .chart__delta--down {
        color: #1b5e20;
      }
    `,
  ],
})
export class PriceHistoryChartComponent {
  /** Series to plot, oldest first (as produced by `MarketEventsStore`). */
  readonly series = input<PricePoint[]>([]);
  /** Label for the series, used in the caption and the accessible name. */
  readonly projectLabel = input<string>('');

  readonly width = 560;
  readonly height = 220;
  readonly padding = { top: 16, right: 16, bottom: 28, left: 56 };

  private readonly hover = signal<number | null>(null);
  readonly hovered = this.hover.asReadonly();

  readonly points = computed(() => this.series().filter((p) => Number.isFinite(p.price)));

  readonly latestPrice = computed(() => this.points().at(-1)?.price ?? 0);

  /** Change from the first recorded price to the latest, or null with <2 points. */
  readonly delta = computed(() => {
    const pts = this.points();
    if (pts.length < 2) return null;
    return pts[pts.length - 1].price - pts[0].price;
  });

  readonly summary = computed(() => {
    const label = this.projectLabel();
    const pts = this.points();
    if (pts.length === 0) return 'Price history chart — no data';
    const scope = label ? ` for ${label}` : '';
    return `Price history chart${scope}: ${pts.length} recorded price${
      pts.length === 1 ? '' : 's'
    }, latest ${this.formatPrice(this.latestPrice())}`;
  });

  readonly describeSeries = computed(() => {
    const pts = this.points();
    if (pts.length === 0) return 'No price points recorded yet.';
    return pts
      .map((p) => `${this.formatDate(p.timestamp)}: ${this.formatPrice(p.price)}`)
      .join('; ');
  });

  private readonly bounds = computed(() => {
    const pts = this.points();
    if (pts.length === 0) return null;
    const prices = pts.map((p) => p.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    // A flat series would divide by zero; give it a band so it renders mid-height.
    const span = max - min || Math.max(Math.abs(max) * 0.1, 1);
    const times = pts.map((p) => p.timestamp);
    return {
      minPrice: min - span * 0.1,
      maxPrice: max + span * 0.1,
      minTime: Math.min(...times),
      maxTime: Math.max(...times),
    };
  });

  /** Chart-space coordinates for every point. */
  readonly plotted = computed(() => {
    const pts = this.points();
    const b = this.bounds();
    if (!b) return [];

    const plotW = this.width - this.padding.left - this.padding.right;
    const plotH = this.height - this.padding.top - this.padding.bottom;
    const timeSpan = b.maxTime - b.minTime;
    const priceSpan = b.maxPrice - b.minPrice;

    return pts.map((p) => ({
      ...p,
      cx:
        this.padding.left +
        (timeSpan === 0 ? plotW / 2 : ((p.timestamp - b.minTime) / timeSpan) * plotW),
      cy:
        this.padding.top +
        plotH -
        (priceSpan === 0 ? plotH / 2 : ((p.price - b.minPrice) / priceSpan) * plotH),
    }));
  });

  readonly gridLines = computed(() => {
    const b = this.bounds();
    if (!b) return [];
    const plotH = this.height - this.padding.top - this.padding.bottom;
    return [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const price = b.minPrice + (b.maxPrice - b.minPrice) * t;
      return {
        value: t,
        y: this.padding.top + plotH * t,
        label: this.formatPrice(price),
      };
    });
  });

  readonly linePath = computed(() =>
    this.points().length < 2
      ? ''
      : this.plotted()
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.cx.toFixed(2)} ${p.cy.toFixed(2)}`)
          .join(' '),
  );

  readonly areaPath = computed(() => {
    const plotted = this.plotted();
    if (plotted.length < 2) return '';
    const baseline = this.height - this.padding.bottom;
    const first = plotted[0];
    const last = plotted[plotted.length - 1];
    return [
      `M ${first.cx.toFixed(2)} ${baseline}`,
      ...plotted.map((p) => `L ${p.cx.toFixed(2)} ${p.cy.toFixed(2)}`),
      `L ${last.cx.toFixed(2)} ${baseline}`,
      'Z',
    ].join(' ');
  });

  readonly firstDate = computed(() => {
    const pts = this.points();
    return pts.length ? this.formatDate(pts[0].timestamp) : '';
  });

  readonly lastDate = computed(() => {
    const pts = this.points();
    return pts.length ? this.formatDate(pts[pts.length - 1].timestamp) : '';
  });

  pointLabel(point: PricePoint & { cx: number; cy: number }): string {
    return `${this.formatDate(point.timestamp)}: ${this.formatPrice(point.price)}${
      point.asset ? ` ${point.asset}` : ''
    }`;
  }

  /** Prices are in base units; 7 decimals is the Stellar convention. */
  formatPrice(value: number): string {
    return (value / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  formatDate(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  onPointFocus(index: number | null): void {
    this.hover.set(index);
  }
}
