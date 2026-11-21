import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Offer } from '@shared';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ToastService } from '../core/services/toast.service';

export type OfferStatusFilter = 'all' | 'open' | 'filled' | 'cancelled';

export interface SalesBreakdownPoint {
  label: string;
  asset: 'XLM' | 'USDC';
  volume: number;
  tonnes: number;
  percent: number;
}

/**
 * Issue #1357 — Seller dashboard with active listings, pending escrow,
 * and sales revenue analytics.
 */
@Component({
  selector: 'app-seller-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './seller-dashboard.component.html',
  styles: [
    `
      .seller-dashboard {
        max-width: 1200px;
        margin: 0 auto;
        padding: 2rem 1.5rem;
      }

      .seller-dashboard__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1.5rem;
        flex-wrap: wrap;
      }

      .seller-dashboard__title {
        font-size: 1.5rem;
        font-weight: 700;
        margin: 0;
      }

      .seller-dashboard__actions {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }

      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 1rem;
        margin-bottom: 2rem;
      }

      .metric-card {
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 0.5rem;
        padding: 1.125rem;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
      }

      .metric-card__label {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #6b7280;
        font-weight: 600;
      }

      .metric-card__value {
        font-size: 1.5rem;
        font-weight: 700;
        color: #111827;
      }

      .metric-card__sub {
        font-size: 0.8125rem;
        color: #4b5563;
      }

      .panel {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 0.5rem;
        padding: 1.25rem;
        margin-bottom: 1.5rem;
      }

      .panel__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1rem;
        flex-wrap: wrap;
      }

      .panel__title {
        font-size: 1.125rem;
        font-weight: 600;
        margin: 0;
      }

      .filter-tabs {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .tab-btn {
        padding: 0.375rem 0.75rem;
        border-radius: 0.375rem;
        border: 1px solid #d1d5db;
        background: #ffffff;
        cursor: pointer;
        font-size: 0.8125rem;
        font-weight: 500;
      }

      .tab-btn--active {
        background: #16a34a;
        border-color: #16a34a;
        color: #ffffff;
      }

      .table-wrap {
        overflow-x: auto;
      }

      .offers-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.875rem;
      }

      .offers-table th,
      .offers-table td {
        text-align: left;
        padding: 0.75rem 0.625rem;
        border-bottom: 1px solid #e5e7eb;
      }

      .offers-table th {
        font-size: 0.75rem;
        text-transform: uppercase;
        color: #6b7280;
        letter-spacing: 0.04em;
      }

      .badge {
        display: inline-block;
        padding: 0.125rem 0.5rem;
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: capitalize;
      }

      .badge--open {
        background: #dcfce7;
        color: #166534;
      }

      .badge--filled {
        background: #dbeafe;
        color: #1e40af;
      }

      .badge--cancelled {
        background: #f3f4f6;
        color: #4b5563;
      }

      .chart-bars {
        display: flex;
        flex-direction: column;
        gap: 0.875rem;
      }

      .chart-row {
        display: grid;
        grid-template-columns: 110px 1fr 140px;
        align-items: center;
        gap: 0.75rem;
        font-size: 0.875rem;
      }

      .chart-track {
        height: 1.125rem;
        background: #f3f4f6;
        border-radius: 9999px;
        overflow: hidden;
      }

      .chart-fill {
        height: 100%;
        border-radius: 9999px;
        transition: width 0.25s ease;
      }

      .chart-fill--xlm {
        background: #16a34a;
      }

      .chart-fill--usdc {
        background: #2563eb;
      }

      .btn {
        cursor: pointer;
        border-radius: 0.375rem;
        padding: 0.45rem 0.9rem;
        font-size: 0.8125rem;
        font-weight: 500;
        border: 1px solid transparent;
      }

      .btn--primary {
        background: #16a34a;
        color: #ffffff;
      }

      .btn--ghost {
        background: #ffffff;
        border-color: #d1d5db;
        color: #374151;
      }

      .btn--danger {
        background: #fef2f2;
        border-color: #fecaca;
        color: #991b1b;
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .alert--error {
        background: #fef2f2;
        color: #991b1b;
        border: 1px solid #fecaca;
        border-radius: 0.375rem;
        padding: 0.75rem 1rem;
        margin-bottom: 1rem;
      }

      .mono {
        font-family: monospace;
      }

      .empty-state {
        color: #6b7280;
        padding: 1.5rem 0;
        text-align: center;
      }
    `,
  ],
})
export class SellerDashboardComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  private readonly toast = inject(ToastService);

  readonly offers = signal<Offer[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly statusFilter = signal<OfferStatusFilter>('all');
  readonly cancellingOfferId = signal<string | null>(null);

  readonly activeOffers = computed(() =>
    this.offers().filter((offer) => offer.status === 'open'),
  );

  readonly filledOffers = computed(() =>
    this.offers().filter((offer) => offer.status === 'filled'),
  );

  readonly totalActiveOffers = computed(() => this.activeOffers().length);

  readonly escrowedTonnes = computed(() =>
    this.activeOffers().reduce(
      (sum, offer) => sum + this.rawToTonnes(offer.tonnes_available),
      0,
    ),
  );

  readonly salesVolumeXlm = computed(() =>
    this.sumSalesVolumeByAsset('XLM'),
  );

  readonly salesVolumeUsdc = computed(() =>
    this.sumSalesVolumeByAsset('USDC'),
  );

  readonly filteredOffers = computed(() => {
    const filter = this.statusFilter();
    const list = this.offers();
    if (filter === 'all') return list;
    return list.filter((offer) => offer.status === filter);
  });

  readonly salesBreakdown = computed<SalesBreakdownPoint[]>(() => {
    const xlmVol = this.salesVolumeXlm();
    const usdcVol = this.salesVolumeUsdc();
    const maxVol = Math.max(xlmVol, usdcVol, 1);

    const xlmTonnes = this.sumSoldTonnesByAsset('XLM');
    const usdcTonnes = this.sumSoldTonnesByAsset('USDC');

    return [
      {
        label: 'XLM Sales',
        asset: 'XLM',
        volume: xlmVol,
        tonnes: xlmTonnes,
        percent: Math.round((xlmVol / maxVol) * 100),
      },
      {
        label: 'USDC Sales',
        asset: 'USDC',
        volume: usdcVol,
        tonnes: usdcTonnes,
        percent: Math.round((usdcVol / maxVol) * 100),
      },
    ];
  });

  ngOnInit(): void {
    const address = this.wallet.publicKey();
    if (address) {
      void this.loadSellerOffers(address);
    }
  }

  async connectAndLoad(): Promise<void> {
    const address = await this.wallet.connect();
    await this.loadSellerOffers(address);
  }

  async refresh(): Promise<void> {
    const address = this.wallet.publicKey();
    if (address) {
      await this.loadSellerOffers(address);
    }
  }

  async loadSellerOffers(address: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    try {
      const offerIds = await firstValueFrom(this.api.getOffersBySeller(address));
      if (!offerIds || offerIds.length === 0) {
        this.offers.set([]);
        return;
      }

      const loaded = await Promise.all(
        offerIds.map((id) => firstValueFrom(this.api.getOffer(Number(id)))),
      );
      this.offers.set(loaded.filter(Boolean));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load seller offers.');
    } finally {
      this.loading.set(false);
    }
  }

  async cancelOffer(offer: Offer): Promise<void> {
    const address = this.wallet.publicKey();
    const token = this.auth.token() ?? '';
    if (!address) return;

    this.cancellingOfferId.set(offer.id);
    try {
      await firstValueFrom(this.api.cancelOffer(Number(offer.id), address, token));
      this.offers.update((list) =>
        list.map((item) => (item.id === offer.id ? { ...item, status: 'cancelled' } : item)),
      );
      this.toast.show(`Offer #${offer.id} cancelled and escrow returned.`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to cancel offer.';
      this.toast.show(msg, 'error');
    } finally {
      this.cancellingOfferId.set(null);
    }
  }

  setFilter(filter: OfferStatusFilter): void {
    this.statusFilter.set(filter);
  }

  getAssetLabel(offer: Offer): 'XLM' | 'USDC' {
    const label = (offer.price_asset_label ?? offer.payment_asset_code ?? 'XLM').toUpperCase();
    return label === 'USDC' ? 'USDC' : 'XLM';
  }

  formatUnitPrice(offer: Offer): string {
    const asset = this.getAssetLabel(offer);
    const raw = offer.price_amount ?? offer.price_raw ?? offer.price_xlm ?? '0';
    const divisor = asset === 'USDC' ? 1_000_000 : 10_000_000;
    const value = Number(raw) / divisor;
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${asset}`;
  }

  formatTonnes(raw: string): string {
    return `${this.rawToTonnes(raw).toLocaleString(undefined, { maximumFractionDigits: 4 })} t`;
  }

  formatDate(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString();
  }

  private rawToTonnes(raw: string): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 0;
    return parsed / 1_000_000;
  }

  private sumSalesVolumeByAsset(asset: 'XLM' | 'USDC'): number {
    return this.filledOffers()
      .filter((offer) => this.getAssetLabel(offer) === asset)
      .reduce((sum, offer) => {
        const rawPrice = Number(offer.price_amount ?? offer.price_raw ?? offer.price_xlm ?? '0');
        const divisor = asset === 'USDC' ? 1_000_000 : 10_000_000;
        const unitPrice = Number.isFinite(rawPrice) ? rawPrice / divisor : 0;
        const tonnes = this.rawToTonnes(offer.tonnes_available);
        return sum + unitPrice * tonnes;
      }, 0);
  }

  private sumSoldTonnesByAsset(asset: 'XLM' | 'USDC'): number {
    return this.filledOffers()
      .filter((offer) => this.getAssetLabel(offer) === asset)
      .reduce((sum, offer) => sum + this.rawToTonnes(offer.tonnes_available), 0);
  }
}
