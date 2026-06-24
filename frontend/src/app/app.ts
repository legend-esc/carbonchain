import { Component, inject } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { ConnectWalletComponent } from './core/components/connect-wallet.component';
import { LocaleSwitcherComponent } from './core/components/locale-switcher.component';
import { ThemeService } from './core/services/theme.service';
import { TranslatePipe } from './core/pipes/translate.pipe';
import { ToastComponent } from './shared/components/toast.component';

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
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly theme = inject(ThemeService);
}
