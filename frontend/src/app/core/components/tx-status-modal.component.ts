import { Component, HostListener, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StellarWalletService, TxStatusStep } from '../services/stellar-wallet.service';

interface StepDefinition {
  number: 1 | 2 | 3 | 4;
  key: Exclude<TxStatusStep, 'idle' | 'error'>;
  title: string;
  description: string;
}

const TX_STEPS: readonly StepDefinition[] = [
  {
    number: 1,
    key: 'preparing',
    title: 'Preparing Transaction',
    description: 'Building Soroban transaction envelope and simulation.',
  },
  {
    number: 2,
    key: 'signing',
    title: 'Waiting for Wallet Signature',
    description: 'Please review and approve the transaction in Freighter.',
  },
  {
    number: 3,
    key: 'submitting',
    title: 'Submitting to Stellar Network',
    description: 'Broadcasting signed XDR and awaiting Horizon confirmation.',
  },
  {
    number: 4,
    key: 'confirmed',
    title: 'Confirmed on Ledger',
    description: 'Transaction finalized on the Stellar ledger.',
  },
];

@Component({
  selector: 'app-tx-status-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (status().visible) {
      <div
        class="tx-modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-status-modal-title"
      >
        <div class="tx-modal">
          <header class="tx-modal__header">
            <h2 id="tx-status-modal-title" class="tx-modal__title">
              {{ status().label || 'Transaction Status' }}
            </h2>
            @if (canClose()) {
              <button
                type="button"
                class="tx-modal__close"
                (click)="close()"
                aria-label="Close transaction status modal"
              >
                ✕
              </button>
            }
          </header>

          <ol class="tx-stepper" aria-label="Transaction progress steps">
            @for (step of steps; track step.number) {
              <li
                class="tx-step"
                [class.tx-step--done]="isStepDone(step.number)"
                [class.tx-step--active]="isStepActive(step.number)"
                [class.tx-step--error]="isStepError(step.number)"
                [attr.aria-current]="isStepActive(step.number) ? 'step' : null"
              >
                <div class="tx-step__indicator" aria-hidden="true">
                  @if (isStepDone(step.number)) {
                    <span>✓</span>
                  } @else if (isStepError(step.number)) {
                    <span>✕</span>
                  } @else if (isStepActive(step.number)) {
                    <span class="tx-spinner"></span>
                  } @else {
                    <span>{{ step.number }}</span>
                  }
                </div>
                <div class="tx-step__body">
                  <div class="tx-step__title">{{ step.number }}. {{ step.title }}</div>
                  <div class="tx-step__desc">{{ step.description }}</div>
                </div>
              </li>
            }
          </ol>

          @if (status().txHash) {
            <div class="tx-hash-box">
              <span class="tx-hash-box__label">Transaction Hash</span>
              <div class="tx-hash-box__row">
                <code class="tx-hash-box__code">{{ shortHash() }}</code>
                <a
                  class="tx-hash-box__link"
                  [href]="explorerUrl()"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Stellar Explorer ↗
                </a>
              </div>
              @if (status().ledgerSeq) {
                <div class="tx-hash-box__ledger">Ledger #{{ status().ledgerSeq }}</div>
              }
            </div>
          }

          @if (status().step === 'error' && status().errorMessage) {
            <div class="tx-alert tx-alert--error" role="alert">
              {{ status().errorMessage }}
            </div>
          }

          @if (canClose()) {
            <footer class="tx-modal__footer">
              <button type="button" class="tx-btn" (click)="close()">
                {{ status().step === 'confirmed' ? 'Done' : 'Close' }}
              </button>
            </footer>
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      .tx-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        z-index: 9998;
      }

      .tx-modal {
        width: 100%;
        max-width: 28rem;
        background: var(--surface-bg, #ffffff);
        color: var(--text-primary, #111827);
        border: 1px solid var(--border-color, #e5e7eb);
        border-radius: 12px;
        padding: 1.25rem 1.5rem;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
      }

      .tx-modal__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        margin-bottom: 1rem;
      }

      .tx-modal__title {
        margin: 0;
        font-size: 1.125rem;
        font-weight: 600;
      }

      .tx-modal__close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 1rem;
        color: inherit;
        opacity: 0.65;
        padding: 0.25rem;
      }
      .tx-modal__close:hover {
        opacity: 1;
      }

      .tx-stepper {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
      }

      .tx-step {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        opacity: 0.5;
        transition: opacity 0.15s ease;
      }

      .tx-step--active,
      .tx-step--done,
      .tx-step--error {
        opacity: 1;
      }

      .tx-step__indicator {
        width: 1.75rem;
        height: 1.75rem;
        border-radius: 9999px;
        border: 2px solid #cbd5e1;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.8rem;
        font-weight: 700;
        flex-shrink: 0;
      }

      .tx-step--active .tx-step__indicator {
        border-color: #1976d2;
        color: #1976d2;
      }

      .tx-step--done .tx-step__indicator {
        background: #2e7d32;
        border-color: #2e7d32;
        color: #ffffff;
      }

      .tx-step--error .tx-step__indicator {
        background: #c62828;
        border-color: #c62828;
        color: #ffffff;
      }

      .tx-step__title {
        font-size: 0.925rem;
        font-weight: 600;
      }

      .tx-step__desc {
        font-size: 0.8rem;
        color: var(--text-muted, #6b7280);
        margin-top: 0.125rem;
      }

      .tx-spinner {
        width: 0.85rem;
        height: 0.85rem;
        border: 2px solid currentColor;
        border-top-color: transparent;
        border-radius: 9999px;
        animation: tx-spin 0.75s linear infinite;
      }

      @keyframes tx-spin {
        to {
          transform: rotate(360deg);
        }
      }

      .tx-hash-box {
        margin-top: 1rem;
        padding: 0.75rem;
        border-radius: 8px;
        background: var(--surface-muted, #f3f4f6);
        font-size: 0.8rem;
      }

      .tx-hash-box__label {
        display: block;
        font-weight: 600;
        margin-bottom: 0.25rem;
        color: var(--text-muted, #4b5563);
      }

      .tx-hash-box__row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .tx-hash-box__code {
        font-family: monospace;
        font-size: 0.8rem;
      }

      .tx-hash-box__link {
        color: #1976d2;
        font-weight: 600;
        text-decoration: none;
      }
      .tx-hash-box__link:hover {
        text-decoration: underline;
      }

      .tx-hash-box__ledger {
        margin-top: 0.35rem;
        color: var(--text-muted, #4b5563);
      }

      .tx-alert--error {
        margin-top: 1rem;
        padding: 0.75rem;
        border-radius: 8px;
        background: #fee2e2;
        color: #991b1b;
        border: 1px solid #fecaca;
        font-size: 0.85rem;
      }

      .tx-modal__footer {
        margin-top: 1.25rem;
        display: flex;
        justify-content: flex-end;
      }

      .tx-btn {
        padding: 0.5rem 1rem;
        border-radius: 6px;
        border: none;
        background: #1976d2;
        color: #ffffff;
        font-weight: 600;
        cursor: pointer;
      }
      .tx-btn:hover {
        background: #1565c0;
      }
    `,
  ],
})
export class TxStatusModalComponent {
  private readonly wallet = inject(StellarWalletService);

  readonly steps = TX_STEPS;
  readonly status = this.wallet.txStatus;

  readonly canClose = computed(() => {
    const step = this.status().step;
    return step === 'confirmed' || step === 'error';
  });

  readonly explorerUrl = computed(() => {
    const hash = this.status().txHash;
    return hash ? this.wallet.getExplorerTxUrl(hash) : '';
  });

  readonly shortHash = computed(() => {
    const hash = this.status().txHash;
    if (!hash) return '';
    return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
  });

  isStepDone(stepNumber: 1 | 2 | 3 | 4): boolean {
    const s = this.status();
    if (s.step === 'confirmed') return true;
    if (s.step === 'error') return stepNumber < s.activeStepNumber;
    return stepNumber < s.activeStepNumber;
  }

  isStepActive(stepNumber: 1 | 2 | 3 | 4): boolean {
    const s = this.status();
    if (s.step === 'confirmed' || s.step === 'error' || s.step === 'idle') return false;
    return stepNumber === s.activeStepNumber;
  }

  isStepError(stepNumber: 1 | 2 | 3 | 4): boolean {
    const s = this.status();
    return s.step === 'error' && stepNumber === s.activeStepNumber;
  }

  close(): void {
    this.wallet.closeTxModal();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.status().visible && this.canClose()) {
      this.close();
    }
  }
}
