import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MarketplaceStore } from '../core/store/marketplace.store';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ConnectWalletComponent } from '../core/components/connect-wallet.component';

@Component({
  selector: 'app-marketplace',
  standalone: true,
  imports: [CommonModule, ConnectWalletComponent],
  template: `
    <div class="marketplace">
      <h1>Marketplace</h1>

      @if (!auth.isAuthenticated()) {
        <div class="auth-prompt">
          <p>Connect your wallet to browse your listings.</p>
          <app-connect-wallet />
        </div>
      } @else {
        <div class="toolbar">
          <span class="subtitle">Listings for {{ wallet.publicKey()! | slice:0:8 }}…</span>
          <button class="btn btn-primary" (click)="refresh()">Refresh</button>
        </div>

        @if (store.isLoading()) {
          <p class="status">Loading offers…</p>
        } @else if (store.error()) {
          <p class="error">{{ store.error() }}</p>
        } @else if (store.activeOffers().length === 0) {
          <p class="status">No active listings found.</p>
        } @else {
          <table class="offer-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Credit ID</th>
                <th>Tonnes</th>
                <th>Price (XLM)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              @for (offer of store.activeOffers(); track offer.id) {
                <tr>
                  <td>{{ offer.id }}</td>
                  <td class="mono">{{ offer.credit_id | slice:0:12 }}…</td>
                  <td>{{ formatTonnes(offer.tonnes_available) }}</td>
                  <td>{{ formatXlm(offer.price_xlm) }}</td>
                  <td><span class="badge badge-open">{{ offer.status }}</span></td>
                </tr>
              }
            </tbody>
          </table>
          <div class="pagination">
            <button class="btn btn-outline" (click)="store.prevPage()" [disabled]="store.page() === 0">← Prev</button>
            <span class="page-info">Page {{ store.page() + 1 }} of {{ store.totalPages() }} · {{ store.totalActiveOffers() }} listings</span>
            <button class="btn btn-outline" (click)="store.nextPage()" [disabled]="store.page() >= store.totalPages() - 1">Next →</button>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .marketplace { max-width: 900px; margin: 0 auto; }
    h1 { margin-bottom: 1rem; }
    .auth-prompt { display: flex; flex-direction: column; gap: 0.75rem; align-items: flex-start; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    .subtitle { color: #666; font-size: 0.9rem; }
    .status { color: #888; }
    .error { color: #e53935; }
    .offer-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .offer-table th, .offer-table td { padding: 0.6rem 0.8rem; border-bottom: 1px solid #eee; text-align: left; }
    .offer-table th { background: #f5f5f5; font-weight: 600; }
    .mono { font-family: monospace; }
    .badge { padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; text-transform: uppercase; }
    .badge-open { background: #e8f5e9; color: #2e7d32; }
    .btn { padding: 0.4rem 1rem; border-radius: 6px; cursor: pointer; border: none; font-size: 0.85rem; }
    .btn-primary { background: #4caf50; color: #fff; }
    .btn-outline { background: transparent; border: 1px solid #ccc; }
    .btn-outline:disabled { opacity: 0.4; cursor: not-allowed; }
    .pagination { display: flex; align-items: center; gap: 1rem; margin-top: 0.75rem; justify-content: flex-end; }
    .page-info { font-size: 0.85rem; color: #666; }
  `],
})
export class MarketplaceComponent implements OnInit {
  protected readonly store = inject(MarketplaceStore);
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);

  ngOnInit(): void {
    const key = this.wallet.publicKey();
    if (key) this.store.loadOffersBySeller(key);
  }

  refresh(): void {
    const key = this.wallet.publicKey();
    if (key) this.store.loadOffersBySeller(key);
  }

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' t';
  }

  formatXlm(stroops: string): string {
    return (Number(stroops) / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
}
