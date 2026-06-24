import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CreditStore } from '../core/store/credit.store';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ApiService } from '../core/services/api.service';
import { CreditStatus, RetirementRecord } from '@shared';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
})
export class DashboardComponent implements OnInit {
  protected readonly store = inject(CreditStore);
  protected readonly wallet = inject(StellarWalletService);
  private readonly api = inject(ApiService);

  protected readonly CreditStatus = CreditStatus;
  protected readonly retirements = signal<RetirementRecord[]>([]);
  protected readonly retirementsLoading = signal(false);
  protected readonly retirementsError = signal<string | null>(null);

  ngOnInit(): void {
    const key = this.wallet.publicKey();
    if (key) {
      void this.store.loadByProject(key);
      void this.loadRetirements(key);
    }
  }

  async connectWallet(): Promise<void> {
    const publicKey = await this.wallet.connect();
    await this.store.loadByProject(publicKey);
    await this.loadRetirements(publicKey);
  }

  selectCredit(id: string): void {
    this.store.select(this.store.selectedId() === id ? null : id);
  }

  formatTonnes(raw: string): string {
    return (
      (Number(BigInt(raw)) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) +
      ' t'
    );
  }

  formatDate(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString();
  }

  private async loadRetirements(buyerKey: string): Promise<void> {
    this.retirementsLoading.set(true);
    this.retirementsError.set(null);
    try {
      // Fetch retirement IDs for retired credits owned by this account
      const retiredCredits = this.store.retiredCredits();
      const records = await Promise.all(
        retiredCredits.map((c) => firstValueFrom(this.api.getRetirement(c.id))),
      );
      this.retirements.set(records.filter(Boolean));
    } catch (err) {
      this.retirementsError.set(err instanceof Error ? err.message : 'Failed to load retirements.');
    } finally {
      this.retirementsLoading.set(false);
    }
  }
}
