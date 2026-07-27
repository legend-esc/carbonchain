import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { ConnectWalletComponent } from './core/components/connect-wallet.component';
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
  readonly pwaInstall = inject(PwaInstallService);

  ngOnInit(): void {
    // Initialize PWA install prompt listener
    this.pwaInstall.initialize();
  }
}
