import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ApiService } from '../core/services/api.service';
import { CreditStore } from '../core/store/credit.store';
import { ConnectWalletComponent } from '../core/components/connect-wallet.component';
import { TranslatePipe } from '../core/pipes/translate.pipe';

type Step = 'form' | 'confirm' | 'success' | 'error';

@Component({
  selector: 'app-retire',
  standalone: true,
  imports: [CommonModule, FormsModule, ConnectWalletComponent, TranslatePipe],
  template: `
    <div class="retire-wizard">
      <h1>{{ 'retire.title' | translate }}</h1>

      @if (!auth.isAuthenticated()) {
        <div class="auth-prompt">
          <p>{{ 'retire.walletPrompt' | translate }}</p>
          <app-connect-wallet />
        </div>
      } @else {
        @if (step() === 'form') {
          <form class="wizard-form" (ngSubmit)="goConfirm()" #f="ngForm">
            <label>
              {{ 'retire.creditId' | translate }}
              <input name="creditId" [(ngModel)]="creditId" required placeholder="037176a1…" />
            </label>
            <label>
              {{ 'retire.tonnes' | translate }}
              <input
                name="tonnes"
                [(ngModel)]="tonnes"
                required
                type="number"
                min="1"
                placeholder="1000000"
              />
            </label>
            <label>
              {{ 'retire.reason' | translate }}
              <input
                name="reason"
                [(ngModel)]="reason"
                required
                placeholder="2024 Scope 3 offset"
              />
            </label>
            <button class="btn btn-primary" type="submit" [disabled]="f.invalid">
              {{ 'retire.review' | translate }}
            </button>
          </form>
        }

        @if (step() === 'confirm') {
          <div class="confirm-box">
            <h2>{{ 'retire.confirmTitle' | translate }}</h2>
            <dl>
              <dt>{{ 'retire.creditId' | translate }}</dt>
              <dd class="mono">{{ creditId }}</dd>
              <dt>{{ 'retire.tonnes' | translate }}</dt>
              <dd>{{ formatTonnes(tonnes) }}</dd>
              <dt>{{ 'retire.reason' | translate }}</dt>
              <dd>{{ reason }}</dd>
              <dt>{{ 'retire.wallet' | translate }}</dt>
              <dd class="mono">{{ wallet.publicKey() }}</dd>
            </dl>
            <div class="actions">
              <button class="btn btn-outline" (click)="step.set('form')">
                {{ 'retire.back' | translate }}
              </button>
              <button class="btn btn-danger" [disabled]="submitting()" (click)="submit()">
                {{
                  submitting() ? ('retire.submitting' | translate) : ('retire.confirm' | translate)
                }}
              </button>
            </div>
          </div>
        }

        @if (step() === 'success') {
          <div class="result success">
            <h2>{{ 'retire.successTitle' | translate }}</h2>
            <p>{{ 'retire.retirementId' | translate }}</p>
            <code>{{ retirementId() }}</code>
            <button class="btn btn-outline" (click)="reset()">
              {{ 'retire.retireAnother' | translate }}
            </button>
          </div>
        }

        @if (step() === 'error') {
          <div class="result error-box">
            <h2>{{ 'retire.errorTitle' | translate }}</h2>
            <p>{{ errorMsg() }}</p>
            <button class="btn btn-outline" (click)="step.set('confirm')">
              {{ 'retire.tryAgain' | translate }}
            </button>
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      .retire-wizard {
        max-width: 560px;
        margin: 0 auto;
      }
      h1 {
        margin-bottom: 1.5rem;
      }
      .auth-prompt {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        align-items: flex-start;
      }
      .wizard-form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.9rem;
        font-weight: 500;
      }
      input {
        padding: 0.5rem 0.75rem;
        border: 1px solid #ccc;
        border-radius: 6px;
        font-size: 0.95rem;
      }
      .confirm-box {
        background: #f9f9f9;
        border: 1px solid #ddd;
        border-radius: 8px;
        padding: 1.5rem;
      }
      dl {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 0.5rem 1rem;
        margin: 1rem 0;
        font-size: 0.9rem;
      }
      dt {
        font-weight: 600;
        color: #555;
      }
      .mono {
        font-family: monospace;
        word-break: break-all;
      }
      .actions {
        display: flex;
        gap: 0.75rem;
        margin-top: 1rem;
      }
      .result {
        padding: 1.5rem;
        border-radius: 8px;
      }
      .success {
        background: #e8f5e9;
      }
      .error-box {
        background: #ffebee;
      }
      code {
        display: block;
        font-family: monospace;
        font-size: 0.85rem;
        word-break: break-all;
        margin: 0.5rem 0 1rem;
      }
      .btn {
        padding: 0.45rem 1.1rem;
        border-radius: 6px;
        cursor: pointer;
        border: none;
        font-size: 0.9rem;
      }
      .btn-primary {
        background: #4caf50;
        color: #fff;
      }
      .btn-primary:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .btn-danger {
        background: #e53935;
        color: #fff;
      }
      .btn-danger:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .btn-outline {
        background: transparent;
        border: 1px solid #ccc;
      }
    `,
  ],
})
export class RetireComponent {
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  private readonly api = inject(ApiService);
  private readonly store = inject(CreditStore);

  creditId = '';
  tonnes = 1_000_000;
  reason = '';

  readonly step = signal<Step>('form');
  readonly submitting = signal(false);
  readonly retirementId = signal<string | null>(null);
  readonly errorMsg = signal<string | null>(null);

  goConfirm(): void {
    this.step.set('confirm');
  }

  async submit(): Promise<void> {
    this.submitting.set(true);
    try {
      const token = this.auth.token()!;
      const { retirementId } = await firstValueFrom(
        this.api.retireCredit(
          {
            buyerPublicKey: this.wallet.publicKey()!,
            creditId: this.creditId,
            tonnes: String(this.tonnes),
            reason: this.reason,
          },
          token,
        ),
      );
      this.retirementId.set(retirementId);
      // Refresh the credit entry in the store so any cached data is updated.
      this.store.loadOne(this.creditId).catch(() => {});
      this.step.set('success');
    } catch (err) {
      this.errorMsg.set(err instanceof Error ? err.message : 'Unknown error.');
      this.step.set('error');
    } finally {
      this.submitting.set(false);
    }
  }

  reset(): void {
    this.creditId = '';
    this.tonnes = 1_000_000;
    this.reason = '';
    this.retirementId.set(null);
    this.errorMsg.set(null);
    this.step.set('form');
  }

  formatTonnes(kg: number): string {
    return (kg / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' t';
  }
}
