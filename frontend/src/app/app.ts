import { Component, effect, inject, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { ConnectWalletComponent } from './core/components/connect-wallet.component';
import { NetworkIndicatorComponent } from './core/components/network-indicator.component';
import { LocaleSwitcherComponent } from './core/components/locale-switcher.component';
import { ThemeService } from './core/services/theme.service';
import { TranslatePipe } from './core/pipes/translate.pipe';
import { ToastComponent } from './shared/components/toast.component';
import { BreadcrumbsComponent } from './shared/components/breadcrumbs.component';
import { OnlineStatusService } from './core/services/online-status.service';
import { InstallPromptComponent } from './core/components/install-prompt.component';
import { TxStatusModalComponent } from './core/components/tx-status-modal.component';
import { PwaInstallService } from './core/services/pwa-install.service';
import { LiveAnnouncerService } from './a11y/live-announcer.service';
import { StellarWalletService, type TxStatusStep, type WalletState } from './core/services/stellar-wallet.service';
import { MarketEventsStore } from './core/store/market-events.store';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    ConnectWalletComponent,
    NetworkIndicatorComponent,
    LocaleSwitcherComponent,
    TranslatePipe,
    ToastComponent,
    BreadcrumbsComponent,
    InstallPromptComponent,
    TxStatusModalComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  readonly theme = inject(ThemeService);
  readonly onlineStatus = inject(OnlineStatusService);
  private readonly swUpdate = inject(SwUpdate, { optional: true });
  private readonly liveAnnouncer = inject(LiveAnnouncerService);
  private readonly wallet = inject(StellarWalletService, { optional: true });
  private readonly marketEvents = inject(MarketEventsStore, { optional: true });

  private prevWalletState: WalletState | null = null;
  private prevTxStep: TxStatusStep = 'idle';
  private seenEventIds = new Set<string>();

  constructor() {
    this.setupLiveAnnouncements();
  }

  ngOnInit(): void {
    this.checkForSwUpdate();
  }

  private setupLiveAnnouncements(): void {
    if (this.wallet) {
      effect(() => {
        const state = this.wallet!.state();
        const address = this.wallet!.publicKey();
        const network = this.wallet!.network();

        if (this.prevWalletState !== null && state !== this.prevWalletState) {
          this.liveAnnouncer.announceWalletState(state, address, network);
        }
        this.prevWalletState = state;
      });

      effect(() => {
        const tx = this.wallet!.txStatus();
        if (tx.step !== this.prevTxStep && (tx.step === 'confirmed' || tx.step === 'error')) {
          this.liveAnnouncer.announceTxStatus(tx.step, tx.label, tx.txHash, tx.errorMessage);
        }
        this.prevTxStep = tx.step;
      });
    }

    if (this.marketEvents) {
      effect(() => {
        const events = this.marketEvents!.events();
        if (this.seenEventIds.size === 0 && events.length > 0) {
          // Seed initial history without announcing stale past events
          for (const ev of events) {
            this.seenEventIds.add(ev.id);
          }
          return;
        }

        for (const ev of events) {
          if (this.seenEventIds.has(ev.id)) continue;
          this.seenEventIds.add(ev.id);

          if (ev.type === 'OfferFilled') {
            this.liveAnnouncer.announceOrderFill({
              offerId: String(ev.data?.['offer_id'] ?? ev.data?.['offerId'] ?? ev.id),
              tonnes: ev.data?.['tonnes'] as string | number | undefined,
              price: (ev.data?.['price_xlm'] ?? ev.data?.['priceAmount'] ?? ev.data?.['price']) as
                | string
                | number
                | undefined,
              asset: (ev.data?.['price_asset_code'] ?? ev.data?.['asset'] ?? 'XLM') as string,
            });
          } else if (ev.type === 'OfferPriceChanged') {
            const price = ev.data?.['price_xlm'] ?? ev.data?.['priceAmount'] ?? ev.data?.['price'];
            if (price !== undefined) {
              this.liveAnnouncer.announcePriceChange({
                projectId: ev.data?.['project_id'] as string | undefined,
                offerId: (ev.data?.['offer_id'] ?? ev.data?.['offerId']) as string | number | undefined,
                price: price as string | number,
                asset: (ev.data?.['price_asset_code'] ?? ev.data?.['asset'] ?? 'XLM') as string,
              });
            }
          }
        }
      });
    }
  }

  /**
   * Check for a new service-worker version on application startup.
   *
   * When the SW has an update available, the browser will activate the new
   * worker on the next page load. This is a passive check — no forced reload —
   * which is sufficient for invalidating the `credits-api` freshness cache
   * configured in ngsw-config.json.
   *
   * The manual "Refresh" button in the UI can call this method directly to
   * force an immediate update check.
   */
  checkForSwUpdate(): void {
    if (!this.swUpdate?.isEnabled) {
      return;
    }
    this.swUpdate.checkForUpdate().catch(() => {
      // Non-fatal: SW update check failure should not block the app
    });
  }
}
