import { Component, inject, signal, computed, OnInit, effect } from '@angular/core';
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
import { TranslationService } from '../core/services/translation.service';
import { RetireDraftStore, WizardStep } from './retire.store';

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
        @if (wallet.networkMismatch()) {
          <div class="network-warning" role="alert">
            ⚠ {{ 'retire.wrongNetwork' | translate: { network: expectedNetwork } }}
          </div>
        }

        @if (draftNotice()) {
          <div class="draft-notice" role="status">{{ draftNotice() }}</div>
        }

        @if (draftRestored()) {
          <div class="draft-restored" role="status">
            {{ 'retire.draftRestored' | translate }}
            <button class="btn btn-outline" type="button" (click)="discardDraft()">
              {{ 'retire.draftDiscard' | translate }}
            </button>
          </div>
        }

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
                min="100000"
                step="100000"
                placeholder="1000000"
              />
              @if (tonnesError) {
                <span class="field-error">{{ 'retire.tonnesError' | translate }}</span>
              }
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
            <button class="btn btn-primary" type="submit" [disabled]="f.invalid || tonnesError || !canSubmit()">
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
              <button class="btn btn-danger" [disabled]="submitting() || !canSubmit()" (click)="submit()">
                {{
                  submitting() ? ('retire.submitting' | translate) : ('retire.confirm' | translate)
                }}
        <!-- Step indicator -->
        <nav class="step-indicator" [attr.aria-label]="'retire.wizardSteps' | translate">
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
          </ol>
        </nav>

        <p class="visually-hidden" role="status">{{ stepAnnouncement() }}</p>

        <!-- ── Step 1: Select Credits ── -->
        @if (currentStep() === 1) {
          <section class="step-panel" aria-labelledby="step1-heading">
            <h2 id="step1-heading">{{ 'retire.step1Title' | translate }}</h2>

            @if (store.isLoading()) {
              <p class="status">{{ 'retire.loadingCredits' | translate }}</p>
            } @else if (activeCredits().length === 0) {
              <p class="status">{{ 'retire.noActiveCredits' | translate }}</p>
            } @else {
              <p class="selection-hint">
                {{ 'retire.selectedCount' | translate: { n: selectedCredits().length } }}
              </p>
              <div class="table-scroll">
              <table class="credit-table" [attr.aria-label]="'retire.col.creditId' | translate">
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        type="checkbox"
                        [checked]="allSelected()"
                        (change)="toggleSelectAll()"
                        [attr.aria-label]="'retire.selectAll' | translate"
                      />
                    </th>
                    <th scope="col">{{ 'retire.col.creditId' | translate }}</th>
                    <th scope="col">{{ 'retire.col.project' | translate }}</th>
                    <th scope="col">{{ 'retire.col.vintage' | translate }}</th>
                    <th scope="col">{{ 'retire.col.methodology' | translate }}</th>
                    <th scope="col">{{ 'retire.col.tonnes' | translate }}</th>
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
                      [attr.aria-label]="'retire.selectCredit' | translate: { id: credit.id }"
                    >
                      <td>
                        <input
                          type="checkbox"
                          [checked]="isSelected(credit)"
                          (change)="toggleCredit(credit)"
                          (click)="$event.stopPropagation()"
                          [attr.aria-label]="'retire.selectCredit' | translate: { id: credit.id }"
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
              </div>
            }

            <div class="step-actions">
              <button
                class="btn btn-primary"
                type="button"
                [disabled]="selectedCredits().length === 0"
                (click)="goToStep(2)"
                [attr.aria-label]="'retire.continueStep2' | translate"
              >
                {{ 'retire.nextReason' | translate: { n: selectedCredits().length } }}
              </button>
            </div>
          </section>
        }

        <!-- ── Step 2: Enter Retirement Reason ── -->
        @if (currentStep() === 2) {
          <section class="step-panel" aria-labelledby="step2-heading">
            <h2 id="step2-heading">{{ 'retire.step2Title' | translate }}</h2>

            <div class="selected-summary">
              <span>{{ 'retire.selectedCount' | translate: { n: selectedCredits().length } }}</span>
              <span>
                {{
                  'retire.totalTonnes'
                    | translate: { t: formatTonnes(totalSelectedTonnes()) }
                }}
              </span>
            </div>

            <label class="reason-label" for="retirement-reason">
              {{ 'retire.reasonLabel' | translate }}
              <textarea
                id="retirement-reason"
                [formControl]="reasonControl"
                [placeholder]="'retire.reasonPlaceholder' | translate"
                rows="4"
                aria-describedby="reason-hint reason-error"
                maxlength="200"
              ></textarea>
              <span id="reason-hint" class="hint">
                {{ 'retire.reasonHint' | translate: { n: reasonControl.value.length } }}
              </span>
              @if (reasonControl.invalid && (reasonControl.dirty || reasonControl.touched)) {
                <span id="reason-error" class="field-error" role="alert">
                  {{ 'retire.reasonError' | translate }}
                </span>
              }
            </label>

            <div class="step-actions">
              <button class="btn btn-outline" type="button" (click)="goToStep(1)">
                {{ 'retire.backStep' | translate }}
              </button>
              <button
                class="btn btn-primary"
                type="button"
                [disabled]="reasonControl.invalid"
                (click)="goToStep(3)"
                [attr.aria-label]="'retire.continueStep3' | translate"
              >
                {{ 'retire.nextConfirm' | translate }}
              </button>
            </div>
          </section>
        }

        <!-- ── Step 3: Confirm & Submit ── -->
        @if (currentStep() === 3) {
          <section class="step-panel" aria-labelledby="step3-heading">
            <h2 id="step3-heading">{{ 'retire.step3Title' | translate }}</h2>

            @if (signingError()) {
              <p class="field-error" role="alert">{{ signingError() }}</p>
            }
            @if (statusMessage()) {
              <p class="status-message" role="status">{{ statusMessage() }}</p>
            }

            @if (tonnesControl.invalid) {
              <p class="field-error" role="alert">{{ 'retire.tonnesError' | translate }}</p>
            }

            <div class="confirm-box">
              <dl>
                <dt>{{ 'retire.creditsToRetire' | translate }}</dt>
                <dd>{{ 'retire.selectedCount' | translate: { n: selectedCredits().length } }}</dd>
                <dt>{{ 'retire.col.tonnes' | translate }}</dt>
                <dd>{{ formatTonnes(totalSelectedTonnes()) }}</dd>
                <dt>{{ 'retire.reasonLabel' | translate }}</dt>
                <dd>{{ reasonControl.value }}</dd>
                <dt>{{ 'retire.yourWallet' | translate }}</dt>
                <dd class="mono">{{ wallet.publicKey() }}</dd>
              </dl>
              <details class="credit-details">
                <summary>{{ 'retire.viewSelected' | translate }}</summary>
                <ul>
                  @for (c of selectedCredits(); track c.id) {
                    <li class="mono">{{ c.id | slice: 0 : 20 }}… — {{ formatTonnes(c.tonnes) }}</li>
                  }
                </ul>
              </details>
            </div>

            <p class="sign-info">{{ 'retire.signInfo' | translate }}</p>

            <div class="step-actions">
              <button
                class="btn btn-outline"
                type="button"
                (click)="goToStep(2)"
                [disabled]="submitting()"
              >
                {{ 'retire.backStep' | translate }}
              </button>
              <button
                class="btn btn-danger"
                type="button"
                [disabled]="submitting() || tonnesControl.invalid"
                (click)="submit()"
                [attr.aria-busy]="submitting()"
                [attr.aria-label]="'retire.signAndRetire' | translate"
              >
                {{
                  (submitting() ? 'retire.signing' : 'retire.signAndRetire') | translate
                }}
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
      /* Issue #963: visually hidden but announced by assistive tech. */
      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
      }
      .auth-prompt {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        align-items: flex-start;
      }
      .network-warning {
        background: #fff3cd;
        border: 1px solid #ffc107;
        border-radius: 6px;
        padding: 0.75rem 1rem;
        margin-bottom: 1rem;
        color: #6b4f00;
        font-size: 0.9rem;
      }

      /* Step indicator */
      .step-indicator__list {
        display: flex;
        align-items: center;
        list-style: none;
        margin: 0 0 2rem;
        padding: 0;
      }
      .step {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 0.6rem;
        border-radius: 6px;
        font-size: 0.85rem;
        color: #595959;
      }
      .step--active {
        color: #1b5e20;
        font-weight: 600;
      }
      .step--done {
        color: #2e7d32;
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
        border-bottom: 1px solid #e0e0e0;
        text-align: left;
      }
      .credit-table th {
        background: #f0f0f0;
        font-weight: 600;
      }
      .credit-row--selected {
        background: #e8f5e9;
      }
      /* Issue #963: rows are not click targets any more (the checkbox is), so
         the interactive styling moved onto the checkbox itself. */
      input[type='checkbox'] {
        width: 1.1rem;
        height: 1.1rem;
        cursor: pointer;
        accent-color: #2e7d32;
      }
      input[type='checkbox']:focus-visible {
        outline: 3px solid #1b5e20;
        outline-offset: 2px;
      }
      /* #962 — narrow viewports scroll the table instead of overflowing. */
      .table-scroll {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      /* Step 2 */
      .selected-summary {
        font-size: 0.85rem;
        color: #4a4a4a;
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
        border: 1px solid #8c8c8c;
        border-radius: 6px;
        font-size: 0.9rem;
        font-family: inherit;
        resize: vertical;
      }
      textarea:focus-visible {
        outline: 3px solid #1b5e20;
        outline-offset: 1px;
      }
      .hint {
        font-size: 0.78rem;
        color: #595959;
      }
      .field-error {
        font-size: 0.83rem;
        color: #c62828;
        font-weight: 500;
      }
      .status-message {
        font-size: 0.85rem;
        color: #1b5e20;
        font-weight: 500;
      }

      /* Step 3 */
      .confirm-box {
        background: #f9f9f9;
        border: 1px solid #d0d0d0;
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
        color: #4a4a4a;
      }
      .mono {
        font-family: monospace;
        word-break: break-all;
      }
      .sign-info {
        font-size: 0.85rem;
        color: #4a4a4a;
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
        color: #4a4a4a;
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
        color: #595959;
      }
      .draft-notice,
      .draft-restored {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.75rem;
        background: #e3f2fd;
        border: 1px solid #90caf9;
        border-radius: 6px;
        padding: 0.6rem 0.9rem;
        margin-bottom: 1rem;
        font-size: 0.85rem;
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
        outline: 3px solid #1b5e20;
        outline-offset: 2px;
      }
      .btn-primary {
        background: #2e7d32;
        color: #fff;
      }
      .btn-primary:disabled {
        background: #9c9c9c;
        cursor: not-allowed;
      }
      .btn-danger {
        background: #c62828;
        color: #fff;
      }
      .btn-danger:disabled {
        background: #a8a8a8;
        cursor: not-allowed;
      }
      .btn-outline {
        background: transparent;
        border: 1px solid #767676;
        color: #262626;
      }
      .btn-outline:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* #962 — responsive pass: full-width wizard, stacked steps, 44px
         touch targets on small screens. */
      @media (max-width: 768px) {
        .retire-wizard {
          max-width: 100%;
          padding: 1rem 0.75rem;
        }
        .step-indicator {
          flex-wrap: wrap;
          gap: 0.25rem;
        }
        .step-divider {
          display: none;
        }
        .step {
          flex: 1 1 100%;
          padding: 0.5rem 0.4rem;
        }
        .step-panel h2 {
          font-size: 1rem;
        }
        dl {
          grid-template-columns: 1fr;
          gap: 0.15rem 0;
        }
        dt {
          font-size: 0.78rem;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        dd {
          margin: 0 0 0.5rem 0;
          word-break: break-word;
        }
        .step-actions {
          flex-direction: column;
          align-items: stretch;
        }
        .btn {
          min-height: 44px;
          width: 100%;
        }
        .credit-row {
          min-height: 44px;
        }
      }

      @media (max-width: 480px) {
        .credit-table {
          font-size: 0.82rem;
        }
        .credit-table th,
        .credit-table td {
          padding: 0.5rem 0.6rem;
        }
        .step-actions .btn {
          padding: 0.6rem 1rem;
        }
      }
  ],
})
export class RetireComponent implements OnInit {
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  private readonly api = inject(ApiService);
  protected readonly store = inject(CreditStore);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  protected readonly draftStore = inject(RetireDraftStore);

  readonly currentStep = signal<WizardStep>(1);
  readonly selectedCredits = signal<CreditMetadata[]>([]);
  readonly submitting = signal(false);
  readonly signingError = signal<string | null>(null);
  /** #959 — surfaced when a stored draft was expired or invalidated. */
  readonly draftNotice = signal<string | null>(null);
  /** #959 — true when a draft was restored from localStorage. */
  readonly draftRestored = signal(false);

  readonly reasonControl = new FormControl<string>('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(200)],
  });

  /** Total tonnes across selected credits — must be a multiple of 100,000. */
  readonly tonnesControl = new FormControl<number>(0, {
    nonNullable: true,
    validators: [multipleOf100kValidator()],
  });

  /**
   * Only Active credits owned by the connected wallet.
   *
   * Issue #965 — the store is (network, address)-scoped, so this list can only
   * ever contain the current account's rows; the `owner` check is kept as a
   * belt-and-braces guard against a project-wide load leaking in.
   */
  readonly activeCredits = computed(() => {
    const owner = this.wallet.publicKey();
    return this.store.credits().filter((c) => c.status === CreditStatus.Active && c.owner === owner);
  });

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

  /** True only when the wallet is connected and on the correct network. */
  readonly canSubmit = computed(() => this.wallet.isConnected() && !this.wallet.networkMismatch());

  /** Exposes the expected network name for display in the template. */
  get expectedNetwork(): string {
    return this.wallet.expectedNetwork();
  }

  /** True when the current tonnes value is not a positive multiple of 100,000. */
  get tonnesError(): boolean {
    const v = this.tonnes;
    return !v || v <= 0 || v % 100_000 !== 0;
  }

  private get tonnes(): number {
    return Number(this.selectedCredits()[0]?.tonnes ?? 1_000_000);
  }

  /**
   * Load the connected account's own credits.
   *
   * Issue #965 — this used to call `loadByProject(pk)`, i.e. it treated the
   * wallet address as a project id. Combined with a store that never reset on
   * an account switch, that surfaced another account's holdings. The owner
   * endpoint is the correct source for "my credits".
   */
  async ngOnInit(): Promise<void> {
    const pk = this.wallet.publicKey();
    if (pk && this.auth.isAuthenticated()) {
      await this.store.loadByOwner(pk);
    }
    // #959 — restore a persisted draft once holdings are available.
    this.restoreDraft();
  }

  /**
   * #959 — rehydrates the wizard from the stored draft. Expired or stale
   * drafts are cleared and surfaced via `draftNotice`.
   */
  private restoreDraft(): void {
    const draft = this.draftStore.restore(this.activeCredits());
    if (!draft) {
      const reason = this.draftStore.notice();
      if (reason) {
        this.draftNotice.set(
          reason === 'expired'
            ? 'Your saved retirement draft expired and was cleared.'
            : 'Your saved retirement draft was out of date and was cleared.',
        );
      }
      return;
    }
    this.selectedCredits.set(this.draftStore.resolve(this.activeCredits()));
    this.reasonControl.setValue(draft.reason);
    this.tonnesControl.setValue(Number(draft.tonnes));
    this.currentStep.set(draft.step);
    this.draftRestored.set(true);
  }

  /** #959 — user-initiated discard of a restored draft. */
  discardDraft(): void {
    this.draftStore.discard();
    this.draftNotice.set(null);
    this.draftRestored.set(false);
    this.reset();
  }

  /** #959 — mirrors wizard state into localStorage on every change. */
  private persistDraft(): void {
    const credits = this.selectedCredits();
    if (credits.length === 0) return;
    this.draftStore.save({
      step: this.currentStep(),
      credits,
      tonnes: this.totalSelectedTonnes(),
      reason: this.reasonControl.value,
    });
  }

  /** Issue #963: announced when the wizard advances. */
  stepAnnouncement(): string {
    const step = this.currentStep();
    const label = this.stepLabel(step);
    return step === 3
      ? `Step 3 of 3, ${label}. Review and submit your retirement.`
      : `Step ${step} of 3, ${label}.`;
  }

  isSelected(credit: CreditMetadata): boolean {
    return this.selectedCredits().some((c) => c.id === credit.id);
  }

  constructor() {
    // #959 — persist selection/step changes. `reasonControl` is a FormControl,
    // so its changes are subscribed separately.
    effect(() => {
      const credits = this.selectedCredits();
      this.currentStep();
      if (credits.length === 0) return;
      this.persistDraft();
    });
    this.reasonControl.valueChanges.subscribe(() => this.persistDraft());
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

  /** True only when the wallet is connected and on the correct network. */
  readonly canSubmit = computed(() => this.wallet.isConnected() && !this.wallet.networkMismatch());

  /** Exposes the expected network name for display in the template. */
  get expectedNetwork(): string {
    return this.wallet.expectedNetwork();
  }

  /** True when the current tonnes value is not a positive multiple of 100,000. */
  get tonnesError(): boolean {
    const v = this.tonnes;
    return !v || v <= 0 || v % 100_000 !== 0;
  }

  goToStep(step: WizardStep): void {
    if (step === 3) {
      this.reasonControl.markAsTouched();
      if (this.reasonControl.invalid) return;
    }
    this.currentStep.set(step);
  }

  stepLabel(step: number): string {
    const i18n = inject(TranslationService);
    switch (step) {
      case 1:
        return i18n.t('retire.step.selectCredits');
      case 2:
        return i18n.t('retire.step.reason');
      case 3:
        return i18n.t('retire.step.confirm');
      default:
        return '';
    }
  }

  /**
   * Submit the retirement.
   *
   * Issue #960 — wallet failures are classified rather than stringified. A
   * `staleEnvelope` (issues #57/#59) is retried exactly once with a freshly
   * built request so the user gets a clean re-prompt instead of a dead end.
   */
  async submit(): Promise<void> {
    const credits = this.selectedCredits();
    const reason = this.reasonControl.value;
    const pk = this.wallet.publicKey();

    if (credits.length === 0 || !pk) return;

    this.tonnesControl.setValue(Number(this.totalSelectedTonnes()));
    if (this.tonnesControl.invalid) {
      this.signingError.set('Total tonnes must be a positive multiple of 100,000.');
      this.currentStep.set(3);
      return;
    }

    this.submitting.set(true);
    this.signingError.set(null);
    this.statusMessage.set('Submitting your retirement…');

    try {
      const token = this.auth.token()!;

      if (credits.length === 1) {
        const credit = credits[0];

        const { retirementId } = await firstValueFrom(
          this.api.retireCredit(
            { buyerPublicKey: pk, creditId: credit.id, tonnes: credit.tonnes, reason },
            token,
          ),
        );

        this.store.loadOne(credit.id).catch(() => {});
        this.clearDraft();
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
          this.clearDraft();
          await this.router.navigate(['/certificates', succeeded[0]]);
        }
      }

      this.reportWalletError(walletError);
    } finally {
      this.submitting.set(false);
    }
  }

  private async dispatchRetirement(
    credits: CreditMetadata[],
    reason: string,
    pk: string,
  ): Promise<void> {
    const token = this.auth.token()!;

    if (credits.length === 1) {
      const credit = credits[0];
      const { retirementId } = await firstValueFrom(
        this.api.retireCredit(
          { buyerPublicKey: pk, creditId: credit.id, tonnes: credit.tonnes, reason },
          token,
        ),
      );
      this.store.loadOne(credit.id).catch(() => {});
      this.toast.showSuccess('Credit retired successfully');
      await this.router.navigate(['/certificates', retirementId]);
      return;
    }

  /** #959 — drops the stored draft after a successful retirement. */
  private clearDraft(): void {
    this.draftStore.discard();
    this.draftRestored.set(false);
  }

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' t';
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

  /** Issue #960 — one actionable message per failure type, never a bare string. */
  private reportWalletError(err: WalletError | unknown): void {
    const walletError = normalizeWalletError(err);
    this.signingError.set(walletError.displayMessage);
    this.statusMessage.set(null);
    this.currentStep.set(3);
  }

  reset(): void {
    this.currentStep.set(1);
    this.selectedCredits.set([]);
    this.reasonControl.reset('');
    this.signingError.set(null);
    this.statusMessage.set(null);
  }

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' t';
  }
}
