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

import { TranslatePipe } from '../core/pipes/translate.pipe';
import { TranslationService } from '../core/services/translation.service';
import { RetireDraftStore, WizardStep } from './retire.store';
import { WalletError, normalizeWalletError } from '../core/services/wallet-errors';

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
  imports: [CommonModule, FormsModule, ReactiveFormsModule, TranslatePipe],
  template: `
    <div class="retire-wizard">
      <h1>{{ 'retire.title' | translate }}</h1>
      <p>Retire component - minimal version</p>
    </div>
  `,
  styles: [`
    .retire-wizard { max-width: 700px; margin: 0 auto; padding: 1.5rem 1rem; }
    h1 { margin-bottom: 1.5rem; }
  `],
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
  readonly draftNotice = signal<string | null>(null);
  readonly draftRestored = signal(false);
  readonly statusMessage = signal<string | null>(null);

  readonly reasonControl = new FormControl<string>('', { validators: [Validators.required] });
  readonly tonnesControl = new FormControl<number | null>(null, { validators: [Validators.required, multipleOf100kValidator()] });

  readonly activeCredits = computed(() => {
    const owner = this.wallet.publicKey();
    return this.store.credits().filter((c) => c.status === CreditStatus.Active && c.owner === owner);
  });

  readonly allSelected = computed(() =>
    this.activeCredits().length > 0 && this.selectedCredits().length === this.activeCredits().length
  );

  readonly totalSelectedTonnes = computed(() =>
    this.selectedCredits().reduce((sum, c) => sum + BigInt(c.tonnes), 0n).toString()
  );

  readonly canSubmit = computed(() => this.wallet.isConnected() && !this.wallet.networkMismatch());

  get expectedNetwork(): string {
    return this.wallet.expectedNetwork();
  }

  get tonnesError(): boolean {
    const v = this.tonnes;
    return !v || v <= 0 || v % 100_000 !== 0;
  }

  private get tonnes(): number {
    return Number(this.selectedCredits()[0]?.tonnes ?? 1_000_000);
  }

  async ngOnInit(): Promise<void> {
    const pk = this.wallet.publicKey();
    if (pk && this.auth.isAuthenticated()) {
      await this.store.loadByOwner(pk);
    }
  }

  stepLabel(step: WizardStep): string {
    const i18n = inject(TranslationService);
    switch (step) {
      case 1: return i18n.t('retire.step.selectCredits');
      case 2: return i18n.t('retire.step.reason');
      case 3: return i18n.t('retire.step.confirm');
      default: return '';
    }
  }

  stepAnnouncement(): string {
    const step = this.currentStep();
    const label = this.stepLabel(step);
    return step === 3
      ? 'Step 3 of 3, ' + label + '. Review and submit your retirement.'
      : 'Step ' + step + ' of 3, ' + label + '.';
  }

  isSelected(credit: CreditMetadata): boolean {
    return this.selectedCredits().some((c) => c.id === credit.id);
  }

  constructor() {
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

  async nextStep(step: WizardStep): Promise<void> {
    if (step === 1 && this.activeCredits().length === 0) return;
    if (step === 2 && this.reasonControl.invalid) return;
    this.currentStep.set(step);
  }

  private persistDraft(): void {
    const credits = this.selectedCredits();
    if (credits.length === 0) return;
    this.draftStore.save({
      step: this.currentStep(),
      credits,
      tonnes: String(this.tonnesControl.value ?? 0),
      reason: this.reasonControl.value ?? '',
    });
  }

  private restoreDraft(): void {
    const draft = this.draftStore.restore(this.activeCredits());
    if (!draft) {
      const reason = this.draftStore.notice();
      if (reason) {
        this.draftNotice.set(
          reason === 'expired'
            ? 'Your saved retirement draft expired and was cleared.'
            : 'Your saved retirement draft was out of date and was cleared.'
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

  discardDraft(): void {
    this.draftStore.discard();
    this.draftNotice.set(null);
    this.draftRestored.set(false);
    this.reset();
  }

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
    this.statusMessage.set('Submitting your retirement...');

    try {
      const token = this.auth.token()!;

      if (credits.length === 1) {
        const credit = credits[0];
        const { retirementId } = await firstValueFrom(
          this.api.retireCredit({ buyerPublicKey: pk, creditId: credit.id, tonnes: credit.tonnes, reason: reason ?? '' }, token)
        );
        this.store.loadOne(credit.id).catch(() => {});
        this.clearDraft();
        await this.router.navigate(['/certificates', retirementId]);
        return;
      }

      const { succeeded, failed } = await firstValueFrom(
        this.api.batchRetire({ buyerPublicKey: pk, creditIds: credits.map((c) => c.id), tonnes: credits.map((c) => c.tonnes), reason: reason ?? '' }, token)
      );

      for (const c of credits) {
        this.store.loadOne(c.id).catch(() => {});
      }

      if (failed.length > 0) {
        this.signingError.set(failed.length + ' credit(s) failed: ' + failed.map((f) => f.reason).join(', '));
      }

      if (succeeded.length > 0) {
        this.toast.showSuccess(succeeded.length + ' credit(s) retired successfully');
        this.clearDraft();
        await this.router.navigate(['/certificates', succeeded[0]]);
      }
    } catch (err) {
      const walletError = normalizeWalletError(err);
      this.signingError.set(walletError.displayMessage);
      this.statusMessage.set(null);
      this.currentStep.set(3);
    } finally {
      this.submitting.set(false);
    }
  }

  private clearDraft(): void {
    this.draftStore.discard();
    this.draftRestored.set(false);
  }

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' t';
  }

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
}
