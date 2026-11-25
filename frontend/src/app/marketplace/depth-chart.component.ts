import { Component, Input, signal, computed, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { OrderBookEntry } from './order-book.component';

interface Point {
  x: number;
  y: number;
}

/** #1328 — SVG depth chart showing cumulative bid/ask volume with hover highlight. */
@Component({
  selector: 'app-depth-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="depth-wrap" (mousemove)="onMouseMove($event)" (mouseleave)="clearHover()">
      <svg
        class="depth-svg"
        [attr.viewBox]="'0 0 ' + W + ' ' + H"
        [attr.width]="W"
        [attr.height]="H"
        role="img"
        aria-label="Market depth chart showing cumulative bid and ask volume"
      >
        <title>Market depth chart</title>

        <!-- Bid area -->
        @if (bidPath()) {
          <path
            [attr.d]="bidPath()!"
            fill="rgba(46,125,50,0.18)"
            stroke="#2e7d32"
            stroke-width="1.5"
          />
        }

        <!-- Ask area -->
        @if (askPath()) {
          <path
            [attr.d]="askPath()!"
            fill="rgba(198,40,40,0.18)"
            stroke="#c62828"
            stroke-width="1.5"
          />
        }

        <!-- Hover crosshair -->
        @if (hoverX() !== null) {
          <line
            [attr.x1]="hoverX()!"
            [attr.y1]="PAD_TOP"
            [attr.x2]="hoverX()!"
            [attr.y2]="H - PAD_BOTTOM"
            stroke="#aaa"
            stroke-width="1"
            stroke-dasharray="4 3"
          />
        }

        <!-- X axis -->
        <line
          [attr.x1]="PAD_LEFT"
          [attr.y1]="H - PAD_BOTTOM"
          [attr.x2]="W - PAD_RIGHT"
          [attr.y2]="H - PAD_BOTTOM"
          stroke="#aaa"
          stroke-width="1"
        />

        <!-- X axis labels -->
        @for (tick of xTicks(); track tick.label) {
          <text
            [attr.x]="tick.x"
            [attr.y]="H - PAD_BOTTOM + 12"
            text-anchor="middle"
            class="dc-label"
          >
            {{ tick.label }}
          </text>
        }

        <!-- Y axis -->
        <line
          [attr.x1]="PAD_LEFT"
          [attr.y1]="PAD_TOP"
          [attr.x2]="PAD_LEFT"
          [attr.y2]="H - PAD_BOTTOM"
          stroke="#aaa"
          stroke-width="1"
        />
      </svg>

      <!-- Hover tooltip -->
      @if (hoverTooltip()) {
        <div
          class="dc-tooltip"
          [style.left.px]="hoverTooltip()!.x + 10"
          [style.top.px]="10"
          role="tooltip"
        >
          <div class="tt-line">
            Price: <strong>{{ hoverTooltip()!.price | number: '1.2-2' }}</strong>
          </div>
          <div class="tt-line">
            Cum. Vol: <strong>{{ hoverTooltip()!.volume | number: '1.2-2' }} t</strong>
          </div>
          <div class="tt-line">
            Side: <strong [class]="hoverTooltip()!.side">{{ hoverTooltip()!.side }}</strong>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .depth-wrap {
        position: relative;
        margin-top: 0.75rem;
        overflow: hidden;
      }

      .depth-svg {
        display: block;
        overflow: visible;
        width: 100%;
        height: auto;
      }

      .dc-label {
        font-size: 9px;
        fill: var(--text-muted, #666);
      }

      .dc-tooltip {
        position: absolute;
        background: rgba(26, 26, 46, 0.9);
        color: #fff;
        border-radius: 6px;
        padding: 0.4rem 0.65rem;
        font-size: 0.75rem;
        pointer-events: none;
        z-index: 10;
        white-space: nowrap;
      }

      .tt-line {
        margin-bottom: 0.1rem;
      }

      .bid {
        color: #81c784;
      }

      .ask {
        color: #ef9a9a;
      }
    `,
  ],
})
export class DepthChartComponent implements OnChanges {
  @Input() bids: OrderBookEntry[] = [];
  @Input() asks: OrderBookEntry[] = [];

  readonly W = 520;
  readonly H = 160;
  readonly PAD_LEFT = 8;
  readonly PAD_RIGHT = 8;
  readonly PAD_TOP = 10;
  readonly PAD_BOTTOM = 20;

  private readonly _bidPath = signal<string | null>(null);
  private readonly _askPath = signal<string | null>(null);
  readonly hoverX = signal<number | null>(null);
  readonly hoverTooltip = signal<{
    price: number;
    volume: number;
    side: 'bid' | 'ask';
    x: number;
  } | null>(null);

  readonly bidPath = this._bidPath.asReadonly();
  readonly askPath = this._askPath.asReadonly();

  private allPrices: number[] = [];
  private maxVol = 1;
  private minPrice = 0;
  private maxPrice = 1;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['bids'] || changes['asks']) {
      this.buildPaths();
    }
  }

  private get plotW(): number {
    return this.W - this.PAD_LEFT - this.PAD_RIGHT;
  }

  private get plotH(): number {
    return this.H - this.PAD_TOP - this.PAD_BOTTOM;
  }

  private px(price: number): number {
    if (this.maxPrice === this.minPrice) return this.PAD_LEFT + this.plotW / 2;
    return this.PAD_LEFT + ((price - this.minPrice) / (this.maxPrice - this.minPrice)) * this.plotW;
  }

  private py(vol: number): number {
    return this.H - this.PAD_BOTTOM - (vol / this.maxVol) * this.plotH;
  }

  private buildPaths(): void {
    if (this.bids.length === 0 && this.asks.length === 0) {
      this._bidPath.set(null);
      this._askPath.set(null);
      return;
    }

    const bidPrices = this.bids.map((e) => e.price);
    const askPrices = this.asks.map((e) => e.price);
    this.allPrices = [...bidPrices, ...askPrices];
    this.minPrice = Math.min(...this.allPrices);
    this.maxPrice = Math.max(...this.allPrices);
    if (this.minPrice === this.maxPrice) {
      this.minPrice -= 1;
      this.maxPrice += 1;
    }

    const maxBidVol = this.bids[this.bids.length - 1]?.total ?? 0;
    const maxAskVol = this.asks[this.asks.length - 1]?.total ?? 0;
    this.maxVol = Math.max(maxBidVol, maxAskVol, 1);

    this._bidPath.set(this.buildSidePath(this.bids));
    this._askPath.set(this.buildSidePath(this.asks));
  }

  private buildSidePath(entries: OrderBookEntry[]): string | null {
    if (entries.length === 0) return null;
    const base = this.H - this.PAD_BOTTOM;
    const pts: Point[] = entries.map((e) => ({ x: this.px(e.price), y: this.py(e.total) }));
    // Step chart: horizontal then vertical
    let d = `M ${pts[0].x} ${base} L ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` H ${pts[i].x} V ${pts[i].y}`;
    }
    // Close back to baseline
    d += ` H ${pts[pts.length - 1].x} V ${base} Z`;
    return d;
  }

  readonly xTicks = computed(() => {
    if (this.allPrices.length === 0) return [];
    const range = this.maxPrice - this.minPrice;
    const step = range / 4;
    return Array.from({ length: 5 }, (_, i) => {
      const price = this.minPrice + step * i;
      return { x: this.px(price), label: price.toFixed(1) };
    });
  });

  onMouseMove(event: MouseEvent): void {
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    const relX = event.clientX - rect.left;
    this.hoverX.set(relX * (this.W / rect.width));

    // Find closest price level
    const svgX = relX * (this.W / rect.width);
    const price =
      this.minPrice + ((svgX - this.PAD_LEFT) / this.plotW) * (this.maxPrice - this.minPrice);

    // Determine which side and volume
    const allEntries = [...this.bids, ...this.asks];
    if (allEntries.length === 0) return;
    const closest = allEntries.reduce((best, e) =>
      Math.abs(e.price - price) < Math.abs(best.price - price) ? e : best,
    );
    this.hoverTooltip.set({
      price: closest.price,
      volume: closest.total,
      side: closest.side,
      x: relX,
    });
  }

  clearHover(): void {
    this.hoverX.set(null);
    this.hoverTooltip.set(null);
  }
}
