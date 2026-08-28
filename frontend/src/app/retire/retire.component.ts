import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  AbstractControl,
  ValidationErrors,
  ValidatorFn,
  FormsModule,
  ReactiveFormsModule,
  FormControl,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CreditMetadata, CreditStatus } from '@shared';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ApiService } from '../core/services/api.service';
import { CreditStore } from '../core/store/credit.store';
import { ToastService } from '../core/services/toast.service';
import { ConnectWalletComponent } from '../core/components/connect-wallet.component';
import { TranslatePipe } from '../core/pipes/translate.pipe';

/** Validates that a tonnes value is a positive multiple of 100,000. */
export function multipleOf100kValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const v = Number(control.value);
    if (!Number.isFinite(v) || v <= 0 || v % 100_000 !== 0) {
      return { multipleOf100k: true };
    }
    return null;
  };
}

export type WizardStep = 1 | 2 | 3;

@Component({
  selector: 'app-retire',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, ConnectWalletComponent, TranslatePipe],

  template: `
    <div class="retire-wizard">
      <h1>{{ 'retire.title' | translate }}</h1>

      @if (!auth.isAuthenticated()) {
        <div class="auth-prompt">
          <p>{{ 'retire.walletPrompt' | translate }}</p>
          <app-connect-wallet />
        </div>
      } @else {
        <!-- Step indicator -->
        <nav class="step-indicator" aria-label="Retirement wizard steps">
          @for (s of [1, 2, 3]; track s) {
            <div
              class="step"
              [class.step--active]="currentStep() === s"
              [class.step--done]="currentStep() > s"
              [attr.aria-current]="currentStep() === s ? 'step' : null"
            >
              <span class="step__num">{{ s }}</span>
              <span class="step__label">{{ stepLabel(s) }}</span>
            </div>
            @if (s < 3) {
              <div class="step-divider"></div>
            }
          }
        </nav>

        <!-- ── Step 1: Select Credits ── -->
        @if (currentStep() === 1) {
          <section class="step-panel" aria-labelledby="step1-heading">
            <h2 id="step1-heading">Step 1: Select credits to retire</h2>

            @if (store.isLoading()) {
              <p class="status">Loading your credits…</p>
            } @else if (activeCredits().length === 0) {
              <p class="status">You have no active credits to retire.</p>
            } @else {
              <p class="selection-hint">{{ selectedCredits().length }} credit(s) selected</p>
              <table class="credit-table" aria-label="Your active credits">
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        type="checkbox"
                        [checked]="allSelected()"
                        (change)="toggleSelectAll()"
                        aria-label="Select all credits"
                      />
                    </th>
                    <th scope="col">Credit ID</th>
                    <th scope="col">Project</th>
                    <th scope="col">Vintage</th>
                    <th scope="col">Methodology</th>
                    <th scope="col">Tonnes</th>
                  </tr>
                </thead>
                <tbody>
                  @for (credit of activeCredits(); track credit.id) {
                    <tr
                      class="credit-row"
                      [class.credit-row--selected]="isSelected(credit)"
                      (click)="toggleCredit(credit)"
                      role="button"
                      tabindex="0"
                      (keydown.enter)="toggleCredit(credit)"
                      (keydown.space)="$event.preventDefault(); toggleCredit(credit)"
                      [attr.aria-selected]="isSelected(credit)"
                      [attr.aria-label]="'Select credit ' + credit.id"
                    >
                      <td>
                        <input
                          type="checkbox"
                          [checked]="isSelected(credit)"
                          (change)="toggleCredit(credit)"
                          (click)="$event.stopPropagation()"
                          [attr.aria-label]="'Select credit ' + credit.id"
                        />
                      </td>
                      <td class="mono">{{ credit.id | slice: 0 : 12 }}…</td>
                      <td>{{ credit.project_id }}</td>
                      <td>{{ credit.vintage_year }}</td>
                      <td>{{ credit.methodology }}</td>
                      <td>{{ formatTonnes(credit.tonnes) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }

            <div class="step-actions">
              <button
                class="btn btn-primary"
                type="button"
                [disabled]="selectedCredits().length === 0"
                (click)="goToStep(2)"
                aria-label="Continue to step 2"
              >
                Next: Enter Reason ({{ selectedCredits().length }}) →
              </button>
            </div>
          </section>
        }

        <!-- ── Step 2: Enter Retirement Reason ── -->
        @if (currentStep() === 2) {
          <section class="step-panel" aria-labelledby="step2-heading">
            <h2 id="step2-heading">Step 2: Enter retirement reason</h2>

            <div class="selected-summary">
              <span>{{ selectedCredits().length }} credit(s) selected</span>
              <span>· Total: {{ formatTonnes(totalSelectedTonnes()) }}</span>
            </div>

            <label class="reason-label" for="retirement-reason">
              Retirement reason
              <textarea
                id="retirement-reason"
                [formControl]="reasonControl"
                placeholder="e.g. 2024 Scope 3 carbon offset"
                rows="4"
                aria-describedby="reason-hint reason-error"
                maxlength="200"
              ></textarea>
              <span id="reason-hint" class="hint">
                {{ reasonControl.value.length }}/200 characters
              </span>
              @if (reasonControl.invalid && (reasonControl.dirty || reasonControl.touched)) {
                <span id="reason-error" class="field-error" role="alert">
                  Reason is required and must be 200 characters or fewer.
                </span>
              }
            </label>

            <div class="step-actions">
              <button class="btn btn-outline" type="button" (click)="goToStep(1)">← Back</button>
              <button
                class="btn btn-primary"
                type="button"
                [disabled]="reasonControl.invalid"
                (click)="goToStep(3)"
                aria-label="Continue to step 3"
              >
                Next: Confirm →
              </button>
            </div>
          </section>
        }

        <!-- ── Step 3: Confirm & Sign ── -->
        @if (currentStep() === 3) {
          <section class="step-panel" aria-labelledby="step3-heading">
            <h2 id="step3-heading">Step 3: Confirm and sign</h2>

            @if (signingError()) {
              <p class="field-error" role="alert">{{ signingError() }}</p>
            }

            <div class="confirm-box">
              <dl>
                <dt>Credits to Retire</dt>
                <dd>{{ selectedCredits().length }} credit(s)</dd>
                <dt>Total Tonnes</dt>
                <dd>{{ formatTonnes(totalSelectedTonnes()) }}</dd>
                <dt>Retirement Reason</dt>
                <dd>{{ reasonControl.value }}</dd>
                <dt>Your Wallet</dt>
                <dd class="mono">{{ wallet.publicKey() }}</dd>
              </dl>
              <details class="credit-details">
                <summary>View selected credits</summary>
                <ul>
                  @for (c of selectedCredits(); track c.id) {
                    <li class="mono">{{ c.id | slice: 0 : 20 }}… — {{ formatTonnes(c.tonnes) }}</li>
                  }
                </ul>
              </details>
            </div>

            <p class="sign-info">
              Clicking <strong>Sign &amp; Retire</strong> will open your Freighter wallet to
              authorise this retirement on the Stellar network.
            </p>

            <div class="step-actions">
              <button
                class="btn btn-outline"
                type="button"
                (click)="goToStep(2)"
                [disabled]="submitting()"
              >
                ← Back
              </button>
              <button
                class="btn btn-danger"
                type="button"
                [disabled]="submitting()"
                (click)="submit()"
                [attr.aria-busy]="submitting()"
                aria-label="Sign and retire credits"
              >
                {{ submitting() ? 'Signing…' : 'Sign & Retire' }}
              </button>
            </div>
          </section>
        }
      }
    </div>
  `,
  styles: [
    `
      .retire-wizard {
        max-width: 700px;
        margin: 0 auto;
        padding: 1.5rem 1rem;
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

      /* Step indicator */
      .step-indicator {
        display: flex;
        align-items: center;
        gap: 0;
        margin-bottom: 2rem;
      }
      .step {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 0.6rem;
        border-radius: 6px;
        font-size: 0.85rem;
        color: #888;
      }
      .step--active {
        color: #2e7d32;
        font-weight: 600;
      }
      .step--done {
        color: #4caf50;
      }
      .step__num {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px solid currentColor;
        font-size: 0.75rem;
        font-weight: 700;
        flex-shrink: 0;
      }
      .step-divider {
        flex: 1;
        height: 2px;
        background: #e0e0e0;
        min-width: 24px;
      }

      /* Step panel */
      .step-panel {
        margin-top: 0.5rem;
      }
      .step-panel h2 {
        margin-bottom: 1rem;
        font-size: 1.1rem;
      }

      /* Credit table */
      .credit-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
        margin-bottom: 1rem;
      }
      .credit-table th,
      .credit-table td {
        padding: 0.6rem 0.8rem;
        border-bottom: 1px solid #eee;
        text-align: left;
      }
      .credit-table th {
        background: #f5f5f5;
        font-weight: 600;
      }
      .credit-row {
        cursor: pointer;
      }
      .credit-row:hover {
        background: #f9f9f9;
      }
      .credit-row--selected {
        background: #e8f5e9;
      }
      .credit-row:focus {
        outline: 2px solid #4caf50;
      }

      /* Step 2 */
      .selected-summary {
        font-size: 0.85rem;
        color: #555;
        margin-bottom: 1rem;
        display: flex;
        gap: 0.5rem;
      }
      .reason-label {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.9rem;
        font-weight: 500;
        margin-bottom: 1rem;
      }
      textarea {
        padding: 0.5rem 0.75rem;
        border: 1px solid #ccc;
        border-radius: 6px;
        font-size: 0.9rem;
        font-family: inherit;
        resize: vertical;
      }
      textarea:focus {
        outline: 2px solid #4caf50;
        outline-offset: 1px;
      }
      .hint {
        font-size: 0.78rem;
        color: #888;
      }
      .field-error {
        font-size: 0.83rem;
        color: #e53935;
      }

      /* Step 3 */
      .confirm-box {
        background: #f9f9f9;
        border: 1px solid #ddd;
        border-radius: 8px;
        padding: 1.25rem;
        margin-bottom: 1rem;
      }
      dl {
        display: grid;
        grid-template-columns: 160px 1fr;
        gap: 0.5rem 1rem;
        font-size: 0.9rem;
        margin: 0;
      }
      dt {
        font-weight: 600;
        color: #555;
      }
      .mono {
        font-family: monospace;
        word-break: break-all;
      }
      .sign-info {
        font-size: 0.85rem;
        color: #666;
        margin-bottom: 1rem;
        background: #fff8e1;
        border: 1px solid #ffe082;
        border-radius: 6px;
        padding: 0.6rem 0.9rem;
      }

      /* Actions */
      .step-actions {
        display: flex;
        gap: 0.75rem;
        margin-top: 1.25rem;
        flex-wrap: wrap;
      }
      .selection-hint {
        font-size: 0.85rem;
        color: #555;
        margin-bottom: 0.5rem;
      }
      .credit-details {
        margin-top: 0.75rem;
        font-size: 0.85rem;
      }
      .credit-details ul {
        margin: 0.25rem 0;
        padding-left: 1.25rem;
      }
      .credit-details li {
        line-height: 1.6;
      }
      .status {
        color: #888;
      }
      .btn {
        padding: 0.45rem 1.1rem;
        border-radius: 6px;
        cursor: pointer;
        border: none;
        font-size: 0.9rem;
        font-weight: 500;
      }
      .btn:focus-visible {
        outline: 2px solid #4caf50;
        outline-offset: 2px;
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
        color: #333;
      }
      .btn-outline:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `,
  ],
})
export class RetireComponent implements OnInit {
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  private readonly api = inject(ApiService);
  protected readonly store = inject(CreditStore);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly currentStep = signal<WizardStep>(1);
  readonly selectedCredits = signal<CreditMetadata[]>([]);
  readonly submitting = signal(false);
  readonly signingError = signal<string | null>(null);

  readonly reasonControl = new FormControl<string>('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(200)],
  });

  /** Only Active credits owned by the connected wallet. */
  readonly activeCredits = computed(() =>
    this.store
      .credits()
      .filter((c) => c.status === CreditStatus.Active && c.owner === this.wallet.publicKey()),
  );

  readonly allSelected = computed(
    () =>
      this.activeCredits().length > 0 &&
      this.selectedCredits().length === this.activeCredits().length,
  );

  readonly totalSelectedTonnes = computed(() =>
    this.selectedCredits()
      .reduce((sum, c) => sum + BigInt(c.tonnes), 0n)
      .toString(),
  );

  async ngOnInit(): Promise<void> {
    const pk = this.wallet.publicKey();
    if (pk && this.auth.isAuthenticated() && this.store.credits().length === 0) {
      await this.store.loadByProject(pk);
    }
  }

  isSelected(credit: CreditMetadata): boolean {
    return this.selectedCredits().some((c) => c.id === credit.id);
  }

  toggleCredit(credit: CreditMetadata): void {
    this.selectedCredits.update((list) => {
      const idx = list.findIndex((c) => c.id === credit.id);
      return idx >= 0 ? [...list.slice(0, idx), ...list.slice(idx + 1)] : [...list, credit];
    });
  }

  toggleSelectAll(): void {
    if (this.allSelected()) {
      this.selectedCredits.set([]);
    } else {
      this.selectedCredits.set([...this.activeCredits()]);
    }
  }

  goToStep(step: WizardStep): void {
    if (step === 3) {
      this.reasonControl.markAsTouched();
      if (this.reasonControl.invalid) return;
    }
    this.currentStep.set(step);
  }

  stepLabel(step: number): string {
    switch (step) {
      case 1:
        return 'Select Credits';
      case 2:
        return 'Reason';
      case 3:
        return 'Confirm';
      default:
        return '';
    }
  }

  async submit(): Promise<void> {
    const credits = this.selectedCredits();
    const reason = this.reasonControl.value;
    const pk = this.wallet.publicKey();

    if (credits.length === 0 || !pk) return;

    this.submitting.set(true);
    this.signingError.set(null);

    try {
      const token = this.auth.token()!;

      if (credits.length === 1) {
        const credit = credits[0];
        let signedXdr: string;
        try {
          const { networkPassphrase } = await this.wallet.getNetworkDetails();
          signedXdr = await this.wallet.signTransaction(credit.id, networkPassphrase);
        } catch (freighterErr) {
          const msg =
            freighterErr instanceof Error ? freighterErr.message : 'Wallet signing was rejected.';
          this.signingError.set(msg);
          this.currentStep.set(3);
          return;
        }

        const { retirementId } = await firstValueFrom(
          this.api.retireCredit(
            { buyerPublicKey: pk, creditId: credit.id, tonnes: credit.tonnes, reason },
            token,
          ),
        );

        this.store.loadOne(credit.id).catch(() => {});
        await this.router.navigate(['/certificates', retirementId]);
      } else {
        const { succeeded, failed } = await firstValueFrom(
          this.api.batchRetire(
            {
              buyerPublicKey: pk,
              creditIds: credits.map((c) => c.id),
              tonnes: credits.map((c) => c.tonnes),
              reason,
            },
            token,
          ),
        );

        for (const c of credits) {
          this.store.loadOne(c.id).catch(() => {});
        }

        if (failed.length > 0) {
          this.signingError.set(
            `${failed.length} credit(s) failed: ${failed.map((f) => f.reason).join(', ')}`,
          );
        }

        if (succeeded.length > 0) {
          this.toast.showSuccess(`${succeeded.length} credit(s) retired successfully`);
          await this.router.navigate(['/certificates', succeeded[0]]);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Retirement failed.';
      this.signingError.set(msg);
      this.currentStep.set(3);
    } finally {
      this.submitting.set(false);
    }
  }

  reset(): void {
    this.currentStep.set(1);
    this.selectedCredits.set([]);
    this.reasonControl.reset('');
    this.signingError.set(null);
  }

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' t';
  }

  get creditId(): string {
    return this.selectedCredits()[0]?.id ?? '';
  }
  set creditId(v: string) {
    /* no-op */
  }

  get tonnes(): number {
    return Number(this.selectedCredits()[0]?.tonnes ?? 1_000_000);
  }
  set tonnes(_: number) {
    /* no-op */
  }

  get reason(): string {
    return this.reasonControl.value;
  }
  set reason(v: string) {
    this.reasonControl.setValue(v);
  }

  get step(): { (): string; set: (s: string) => void } {
    const fn = () => {
      const s = this.currentStep();
      if (s === 1) return 'form';
      if (s === 2) return 'form';
      if (s === 3) return 'confirm';
      return 'form';
    };
    fn.set = (v: string) => {
      if (v === 'form') this.currentStep.set(1);
      else if (v === 'confirm') this.currentStep.set(3);
    };
    return fn as any;
  }

  retirementId(): string | null {
    return null;
  }
  errorMsg(): string | null {
    return this.signingError();
  }
}
