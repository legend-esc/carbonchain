import { Component, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MarketplaceStore } from '../core/store/marketplace.store';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ConnectWalletComponent } from '../core/components/connect-wallet.component';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { MarketplaceListComponent } from './marketplace-list.component';
import { OfferDetailComponent } from './offer-detail.component';
import { Offer } from '@shared';

@Component({
  selector: 'app-marketplace',
  standalone: true,
  imports: [
    CommonModule,
    ConnectWalletComponent,
    TranslatePipe,
    MarketplaceListComponent,
    OfferDetailComponent,
  ],
  template: `
    <div class="marketplace">
      <h1>{{ 'marketplace.title' | translate }}</h1>

      @if (!auth.isAuthenticated()) {
        <div class="auth-prompt">
          <p>{{ 'marketplace.walletPrompt' | translate }}</p>
          <app-connect-wallet />
        </div>
      } @else {
        @if (wallet.networkMismatch()) {
          <div class="network-warning" role="alert">
            ⚠ Your wallet is on the wrong network. Please switch to {{ wallet.expectedNetwork() }} in Freighter.
          </div>
        }

        <app-marketplace-list (offerSelected)="onOfferSelected($event)" />

        @if (selectedOffer()) {
          <div class="overlay" (click)="selectedOffer.set(null)" role="presentation"></div>
          <div class="modal" role="dialog" aria-modal="true">
            <app-offer-detail
              [offer]="selectedOffer()!"
              (closed)="selectedOffer.set(null)"
              (buy)="onBuyComplete($event)"
              (cancelled)="onCancelled($event)"
            />
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .marketplace { max-width: 960px; margin: 0 auto; padding: 1rem; }
    h1 { margin-bottom: 1.5rem; }
    .network-warning {
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      color: #856404;
      font-size: 0.9rem;
    }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 10; }
    .modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 11; }
  `],
})
export class MarketplaceComponent {
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  protected readonly store = inject(MarketplaceStore);
  protected readonly selectedOffer = signal<Offer | null>(null);

  onOfferSelected(offer: Offer): void {
    this.selectedOffer.set(offer);
  }

  onBuyComplete(offer: Offer): void {
    this.selectedOffer.set(null);
    // Reload listings after a successful purchase
    const pk = this.wallet.publicKey();
    if (pk) void this.store.loadOffersBySeller(pk);
  }

  onCancelled(offer: Offer): void {
    this.selectedOffer.set(null);
    // Reload listings after cancellation
    const pk = this.wallet.publicKey();
    if (pk) void this.store.loadOffersBySeller(pk);
  }
}
