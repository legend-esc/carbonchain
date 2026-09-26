import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { ConnectWalletComponent } from './core/components/connect-wallet.component';
import { NetworkIndicatorComponent } from './core/components/network-indicator.component';
import { LocaleSwitcherComponent } from './core/components/locale-switcher.component';
import { ThemeService } from './core/services/theme.service';
import { TranslatePipe } from './core/pipes/translate.pipe';
import { ToastComponent } from './shared/components/toast.component';
import { OnlineStatusService } from './core/services/online-status.service';
import { InstallPromptComponent } from './core/components/install-prompt.component';
import { PwaInstallService } from './core/services/pwa-install.service';

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
    InstallPromptComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  readonly theme = inject(ThemeService);
  readonly onlineStatus = inject(OnlineStatusService);
  private readonly swUpdate = inject(SwUpdate, { optional: true });

  ngOnInit(): void {
    this.checkForSwUpdate();
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
