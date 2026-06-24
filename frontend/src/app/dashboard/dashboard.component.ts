import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CreditStore } from '../core/store/credit.store';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { CreditStatus } from '@shared';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
})
export class DashboardComponent implements OnInit {
  protected readonly store = inject(CreditStore);
  protected readonly wallet = inject(StellarWalletService);

  // Expose enum to template
  protected readonly CreditStatus = CreditStatus;
  protected readonly skeletonRows = Array(5);

  ngOnInit(): void {
    // If a wallet is already connected, load credits for that account
    const key = this.wallet.publicKey();
    if (key) {
      this.store.loadByProject(key);
    }
  }

  async connectWallet(): Promise<void> {
    const publicKey = await this.wallet.connect();
    await this.store.loadByProject(publicKey);
  }

  selectCredit(id: string): void {
    this.store.select(id);
  }

  formatTonnes(raw: string): string {
    // tonnes stored as BigInt string — display as a locale number
    return BigInt(raw).toLocaleString();
  }
}
