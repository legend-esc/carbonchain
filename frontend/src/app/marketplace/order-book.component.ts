import {
  Component,
  Input,
  OnInit,
  OnDestroy,
  signal,
  computed,
  inject,
  NgZone,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DepthChartComponent } from './depth-chart.component';

// ── Types ────────────────────────────────────────��─────────────────────────

export interface OrderBookEntry {
  price: number;   // $/tonne
  quantity: number; // tonnes
  total: number;   // cumulative volume at this price level
  side: 'bid' | 'ask';
}

export interface OrderBookMessage {
  type: 'snapshot' | 'update';
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
}

export function buildLevels(
  raw: Array<{ price: number; quantity: number }>,
  side: 'bid' | 'ask',
): OrderBookEntry[] {
  // Aggregate by price level
  const agg = new Map<number, number>();
  for (const { price, quantity } of raw) {
    agg.set(price, (agg.get(price) ?? 0) + quantity);
  }

  // Sort: bids descending, asks ascending
  const sorted = Array.from(agg.entries())
    .filter(([, qty]) => qty > 0)
    .sort((a, b) => (side === 'bid' ? b[0] - a[0] : a[0] - b[0]));

  // Compute cumulative totals
  let cum = 0;
  return sorted.map(([price, quantity]) => {
    cum += quantity;
    return { price, quantity, total: cum, side };
  });
}

/** #1328 — Live order book with bid/ask lists and depth chart. Connects to WS gateway. */
@Component({
  selector: 'app-order-book',
  standalone: true,
  imports: [CommonModule, DepthChartComponent],
  template: `
    <section class="order-book" aria-labelledby="ob-title">
      <div class="ob-header">
        <h2 id="ob-title">Order Book</h2>
        <span
          class="ws-badge"
          [class.ws-badge--connected]="connected()"
          [attr.aria-label]="connected() ? 'Live feed connected' : 'Connecting…'"
          role="status"
        >
          {{ connected() ? '● Live' : '○ Connecting…' }}
        </span>
      </div>

      @if (error()) {
        <p class="ob-error" role="alert">{{ error() }}</p>
      }

      <div class="ob-panels">
        <!-- Asks (sell orders) — ascending price -->
        <div class="ob-side ob-asks">
          <h3 class="side-heading ask-heading">Asks (Sell)</h3>
          <div class="ob-table-wrap">
            <table class="ob-table" aria-label="Ask orders">
              <thead>
                <tr>
                  <th scope="col">Price</th>
                  <th scope="col">Qty (t)</th>
                  <th scope="col">Total (t)</th>
                </tr>
              </thead>
              <tbody>
                @if (asks().length === 0) {
                  <tr>
                    <td colspan="3" class="ob-empty">No asks</td>
                  </tr>
                } @else {
                  @for (entry of asks().slice(0, MAX_ROWS); track entry.price) {
                    <tr
                      class="ob-row ask-row"
                      [style.background]="depthBackground('ask', entry.total, maxAskTotal())"
                    >
                      <td class="price ask-price">{{ entry.price | number: '1.2-2' }}</td>
                      <td>{{ entry.quantity | number: '1.2-2' }}</td>
                      <td>{{ entry.total | number: '1.2-2' }}</td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        </div>

        <!-- Spread indicator -->
        <div class="spread-row" aria-live="polite">
          @if (spread() !== null) {
            <span class="spread-label">Spread</span>
            <span class="spread-value">{{ spread() | number: '1.2-2' }}</span>
          }
        </div>

        <!-- Bids (buy orders) — descending price -->
        <div class="ob-side ob-bids">
          <h3 class="side-heading bid-heading">Bids (Buy)</h3>
          <div class="ob-table-wrap">
            <table class="ob-table" aria-label="Bid orders">
              <thead>
                <tr>
                  <th scope="col">Price</th>
                  <th scope="col">Qty (t)</th>
                  <th scope="col">Total (t)</th>
                </tr>
              </thead>
              <tbody>
                @if (bids().length === 0) {
                  <tr>
                    <td colspan="3" class="ob-empty">No bids</td>
                  </tr>
                } @else {
                  @for (entry of bids().slice(0, MAX_ROWS); track entry.price) {
                    <tr
                      class="ob-row bid-row"
                      [style.background]="depthBackground('bid', entry.total, maxBidTotal())"
                    >
                      <td class="price bid-price">{{ entry.price | number: '1.2-2' }}</td>
                      <td>{{ entry.quantity | number: '1.2-2' }}</td>
                      <td>{{ entry.total | number: '1.2-2' }}</td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Depth chart -->
      <app-depth-chart [bids]="bids()" [asks]="asks()" />
    </section>
  `,
  styles: [
    `
      .order-book {
        background: var(--surface, #f9f9f9);
        border: 1px solid var(--border, #e0e0e0);
        border-radius: 8px;
        padding: 1rem 1.25rem;
      }

      .ob-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.75rem;
      }

      .ob-header h2 {
        margin: 0;
        font-size: 1rem;
        color: var(--text, #1a1a2e);
      }

      /* Live badge */
      .ws-badge {
        font-size: 0.75rem;
        font-weight: 600;
        padding: 0.2rem 0.6rem;
        border-radius: 999px;
        background: var(--border, #ddd);
        color: var(--text-muted, #555);
      }

      .ws-badge--connected {
        background: #e8f5e9;
        color: #2e7d32;
      }

      .ob-error {
        color: #c62828;
        font-size: 0.85rem;
        margin-bottom: 0.5rem;
      }

      /* Side panels */
      .ob-panels {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        gap: 0.75rem;
        align-items: start;
      }

      @media (max-width: 600px) {
        .ob-panels {
          grid-template-columns: 1fr;
        }
      }

      .ob-side {
        min-width: 0;
      }

      .side-heading {
        margin: 0 0 0.4rem;
        font-size: 0.8rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .ask-heading {
        color: #c62828;
      }

      .bid-heading {
        color: #2e7d32;
      }

      .ob-table-wrap {
        overflow-x: auto;
      }

      .ob-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.8rem;
      }

      .ob-table th {
        text-align: right;
        padding: 0.2rem 0.4rem;
        font-weight: 600;
        color: var(--text-muted, #555);
        font-size: 0.7rem;
        text-transform: uppercase;
        border-bottom: 1px solid var(--border, #ddd);
        background: transparent;
      }

      .ob-table th:first-child,
      .ob-table td:first-child {
        text-align: left;
      }

      .ob-table td {
        text-align: right;
        padding: 0.18rem 0.4rem;
        font-variant-numeric: tabular-nums;
        position: relative;
      }

      .ob-row {
        transition: opacity 0.08s;
      }

      .ob-row:hover {
        opacity: 0.75;
      }

      .ob-empty {
        text-align: center;
        color: var(--text-muted, #888);
        padding: 0.5rem;
      }

      /* Price colours */
      .ask-price {
        color: #c62828;
        font-weight: 600;
      }

      .bid-price {
        color: #2e7d32;
        font-weight: 600;
      }

      /* Spread */
      .spread-row {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.1rem;
        padding: 0 0.5rem;
      }

      .spread-label {
        font-size: 0.65rem;
        color: var(--text-muted, #888);
        text-transform: uppercase;
      }

      .spread-value {
        font-size: 0.85rem;
        font-weight: 700;
        color: var(--text, #1a1a2e);
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class OrderBookComponent implements OnInit, OnDestroy {
  /** WebSocket URL — override in tests via Input. */
  @Input() wsUrl: string = this.resolveWsUrl();

  private readonly zone = inject(NgZone);

  readonly connected = signal(false);
  readonly error = signal<string | null>(null);

  private readonly _bids = signal<OrderBookEntry[]>([]);
  private readonly _asks = signal<OrderBookEntry[]>([]);

  readonly bids = this._bids.asReadonly();
  readonly asks = this._asks.asReadonly();

  readonly maxBidTotal = computed(() => this._bids()[this._bids().length - 1]?.total ?? 1);
  readonly maxAskTotal = computed(() => this._asks()[this._asks().length - 1]?.total ?? 1);

  readonly spread = computed(() => {
    const bestAsk = this._asks()[0]?.price;
    const bestBid = this._bids()[0]?.price;
    if (bestAsk == null || bestBid == null) return null;
    return bestAsk - bestBid;
  });

  readonly MAX_ROWS = 10;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  ngOnInit(): void {
    this.connect();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cleanup();
  }

  private resolveWsUrl(): string {
    return 'ws://localhost:3000/order-book';
  }

  private connect(): void {
    if (this.destroyed) return;
    this.cleanup();
    try {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.zone.run(() => {
          this.connected.set(true);
          this.error.set(null);
        });
      };

      ws.onmessage = (ev: MessageEvent) => {
        this.zone.run(() => this.handleMessage(ev.data as string));
      };

      ws.onerror = () => {
        this.zone.run(() => {
          this.connected.set(false);
          this.error.set('WebSocket error — retrying…');
        });
      };

      ws.onclose = () => {
        this.zone.run(() => {
          this.connected.set(false);
        });
        if (!this.destroyed) {
          this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        }
      };
    } catch (err) {
      this.error.set('Could not connect to order book feed.');
    }
  }

  private handleMessage(raw: string): void {
    let msg: OrderBookMessage;
    try {
      msg = JSON.parse(raw) as OrderBookMessage;
    } catch {
      return; // ignore malformed frames
    }
    if (msg.type === 'snapshot') {
      this._bids.set(buildLevels(msg.bids, 'bid'));
      this._asks.set(buildLevels(msg.asks, 'ask'));
    } else if (msg.type === 'update') {
      this._bids.update((prev) => buildLevels([...prev.map(e => ({ price: e.price, quantity: e.quantity })), ...msg.bids], 'bid'));
      this._asks.update((prev) => buildLevels([...prev.map(e => ({ price: e.price, quantity: e.quantity })), ...msg.asks], 'ask'));
    }
  }

  private cleanup(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState < WebSocket.CLOSING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  /**
   * Returns a CSS background gradient showing depth fill proportional to
   * cumulative volume.
   */
  depthBackground(side: 'bid' | 'ask', total: number, max: number): string {
    const pct = max > 0 ? (total / max) * 100 : 0;
    const color = side === 'bid' ? 'rgba(46,125,50,0.12)' : 'rgba(198,40,40,0.12)';
    return `linear-gradient(to right, ${color} ${pct}%, transparent ${pct}%)`;
  }
}
