import { Component, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MarketplaceStore } from '../core/store/marketplace.store';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ConnectWalletComponent } from '../core/components/connect-wallet.component';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { Offer } from '@shared';

@Component({
  selector: 'app-marketplace',
  standalone: true,
  imports: [CommonModule, ConnectWalletComponent, TranslatePipe],
  template: `
    <div class="marketplace">
      <h1>{{ 'marketplace.title' | translate }}</h1>

      @if (!auth.isAuthenticated()) {
        <div class="auth-prompt">
          <p>{{ 'marketplace.walletPrompt' | translate }}</p>
          <app-connect-wallet />
        </div>
      } @else {
        <div class="toolbar">
          <span class="subtitle"
            >{{ 'marketplace.listingsFor' | translate }}
            {{ wallet.publicKey()! | slice: 0 : 8 }}…</span
          >
          <button class="btn btn-primary" (click)="refresh()">
            {{ 'marketplace.refresh' | translate }}
          </button>
        </div>

        @if (store.isLoading()) {
          <p class="status">{{ 'marketplace.loading' | translate }}</p>
        } @else {
          <ng-container *ngIf="store.error$ | async as err">
            @if (err) {
              <p class="error">{{ err }}</p>
            } @else if (store.activeOffers().length === 0) {
              <p class="status">{{ 'marketplace.noListings' | translate }}</p>
            } @else {
              <table class="offer-table">
                <thead>
                  <tr>
                    <th>{{ 'marketplace.col.id' | translate }}</th>
                    <th>{{ 'marketplace.col.creditId' | translate }}</th>
                    <th>{{ 'marketplace.col.tonnes' | translate }}</th>
                    <th>{{ 'marketplace.col.price' | translate }}</th>
                    <th>{{ 'marketplace.col.status' | translate }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (offer of store.activeOffers(); track offer.id) {
                    <tr>
                      <td>{{ offer.id }}</td>
                      <td class="mono">{{ offer.credit_id | slice: 0 : 12 }}…</td>
                      <td>{{ formatTonnes(offer.tonnes_available) }}</td>
                      <td>{{ formatXlm(offer.price_xlm) }}</td>
                      <td>
                        <span class="badge badge-open">{{ offer.status }}</span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
              <div class="pagination">
                <button
                  class="btn btn-outline"
                  (click)="store.prevPage()"
                  [disabled]="store.page() === 0"
                >
                  ← Prev
                </button>
                <span class="page-info"
                  >Page {{ store.page() + 1 }} of {{ store.totalPages() }} ·
                  {{ store.totalActiveOffers() }} listings</span
                >
                <button
                  class="btn btn-outline"
                  (click)="store.nextPage()"
                  [disabled]="store.page() >= store.totalPages() - 1"
                >
                  Next →
                </button>
              </div>
            }
          </ng-container>
        }
      }
    </div>
  `,
  styles: [
    `
      .marketplace {
        max-width: 960px;
        margin: 0 auto;
        padding: 1rem;
      }
      h1 {
        margin-bottom: 1.5rem;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 10;
      }
      .modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 11;
      }
    `,
  ],
})
export class MarketplaceComponent {
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  protected readonly store = inject(MarketplaceStore);
  protected readonly selectedOffer = signal<Offer | null>(null);

  refresh(): void {
    const pk = this.wallet.publicKey();
    if (pk) void this.store.loadOffersBySeller(pk);
  }

  formatTonnes(tonnes: string): string {
    const val = Number(tonnes) / 1_000_000;
    return val.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' t';
  }

  formatXlm(price: string): string {
    return Number(price).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' XLM';
  }

  onBuy(offer: Offer): void {
    // TODO: wire up to retirement/purchase flow
    alert(`Buy flow for offer ${offer.id} — coming soon.`);
    this.selectedOffer.set(null);
  }
}
