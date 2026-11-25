import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, Validators } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CreditMetadata, CreditStatus } from '@shared';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ApiService } from '../core/services/api.service';
import { CreditStore } from '../core/store/credit.store';
import { ToastService } from '../core/services/toast.service';
import { normalizeWalletError } from '../core/services/wallet-errors';

export type WizardStep = 1 | 2 | 3 | 4;

const XLM_PER_OP = 0.00001; // base Soroban tx fee estimate (XLM)
const PLATFORM_FEE_PCT = 0.015; // 1.5% platform fee

/** #1327 — 4-step guided retirement wizard with live fee preview and confetti. */
@Component({
  selector: 'app-retire-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, RouterModule],
  template: `
    <div class="wizard" aria-label="Credit retirement wizard">
      <!-- Progress bar -->
      <nav class="wizard-progress" aria-label="Wizard steps">
        @for (s of steps; track s.n) {
          <div
            class="step-indicator"
            [class.active]="currentStep() === s.n"
            [class.done]="currentStep() > s.n"
            [attr.aria-current]="currentStep() === s.n ? 'step' : null"
          >
            <span class="step-circle">
              @if (currentStep() > s.n) {
                ✓
              } @else {
                {{ s.n }}
              }
            </span>
            <span class="step-label">{{ s.label }}</span>
          </div>
          @if (s.n < 4) {
            <div class="step-connector" [class.done]="currentStep() > s.n"></div>
          }
        }
      </nav>

      <span class="sr-only" aria-live="polite" role="status">{{ stepAnnouncement() }}</span>

      <!-- ── Step 1: Select Credits ──────────────────────────────────────── -->
      @if (currentStep() === 1) {
        <section class="step-panel" aria-labelledby="step1-title">
          <h2 id="step1-title">Select Credits to Retire</h2>

          @if (activeCredits().length === 0) {
            <p class="status">No active credits in your wallet.</p>
          } @else {
            <div class="credit-list" role="list" aria-label="Available credits">
              @for (credit of activeCredits(); track credit.id) {
                <label class="credit-card" role="listitem">
                  <input
                    type="checkbox"
                    [checked]="isSelected(credit)"
                    (change)="toggleCredit(credit)"
                    [attr.aria-label]="'Select credit ' + credit.id"
                  />
                  <div class="credit-info">
                    <span class="credit-id mono">{{ credit.id | slice: 0 : 12 }}…</span>
                    <span class="credit-meta">
                      {{ credit.vintage_year }} · {{ credit.methodology }} · {{ credit.geography }}
                    </span>
                    <span class="credit-tonnes"> {{ tonnesDisplay(credit.tonnes) }} t CO₂e </span>
                  </div>
                </label>
              }
            </div>

            <div class="selection-summary" aria-live="polite">
              {{ selectedCredits().length }} credit(s) selected —
              {{ tonnesDisplay(totalSelectedTonnesRaw()) }} t CO₂e
            </div>
          }

          <div class="step-actions">
            <button
              class="btn btn-primary"
              type="button"
              (click)="goToStep(2)"
              [disabled]="selectedCredits().length === 0"
            >
              Next: Beneficiary &amp; Reason →
            </button>
          </div>
        </section>
      }

      <!-- ── Step 2: Beneficiary & Reason ───────────────────────────────── -->
      @if (currentStep() === 2) {
        <section class="step-panel" aria-labelledby="step2-title">
          <h2 id="step2-title">Beneficiary &amp; Offset Reason</h2>

          <div class="form-field">
            <label class="field-label" for="beneficiary">Beneficiary Name</label>
            <input
              id="beneficiary"
              class="text-input"
              type="text"
              placeholder="Organisation or individual name"
              [(ngModel)]="beneficiary"
              [attr.aria-invalid]="step2Submitted() && !beneficiary.trim() ? 'true' : null"
            />
            @if (step2Submitted() && !beneficiary.trim()) {
              <span class="field-error" role="alert">Beneficiary is required.</span>
            }
          </div>

          <div class="form-field">
            <label class="field-label" for="reason">Offset Reason</label>
            <textarea
              id="reason"
              class="text-input"
              rows="3"
              placeholder="e.g. Voluntary carbon neutral commitment 2024"
              [formControl]="reasonControl"
              [attr.aria-invalid]="step2Submitted() && reasonControl.invalid ? 'true' : null"
            ></textarea>
            @if (step2Submitted() && reasonControl.invalid) {
              <span class="field-error" role="alert">A reason is required.</span>
            }
          </div>

          <div class="step-actions">
            <button class="btn btn-outline" type="button" (click)="goToStep(1)">← Back</button>
            <button class="btn btn-primary" type="button" (click)="submitStep2()">
              Next: Preview &amp; Fees →
            </button>
          </div>
        </section>
      }

      <!-- ── Step 3: Preview Certificate & Network Fees ─────────────────── -->
      @if (currentStep() === 3) {
        <section class="step-panel" aria-labelledby="step3-title">
          <h2 id="step3-title">Preview Certificate &amp; Network Fees</h2>

          <dl class="preview-dl">
            <dt>Beneficiary</dt>
            <dd>{{ beneficiary }}</dd>
            <dt>Reason</dt>
            <dd>{{ reasonControl.value }}</dd>
            <dt>Credits</dt>
            <dd>{{ selectedCredits().length }} credit(s)</dd>
            <dt>Total Retiring</dt>
            <dd>{{ tonnesDisplay(totalSelectedTonnesRaw()) }} t CO₂e</dd>
          </dl>

          <!-- Live fee breakdown -->
          <section class="fee-breakdown" aria-labelledby="fee-title">
            <h3 id="fee-title">Cost Estimate</h3>
            <table class="fee-table" aria-label="Cost breakdown">
              <tbody>
                <tr>
                  <td>Credit Cost</td>
                  <td class="fee-val">{{ creditCost() | number: '1.2-2' }} XLM</td>
                </tr>
                <tr>
                  <td>Platform Fee (1.5%)</td>
                  <td class="fee-val">{{ platformFee() | number: '1.4-4' }} XLM</td>
                </tr>
                <tr>
                  <td>Soroban Gas Fee (est.)</td>
                  <td class="fee-val">{{ gasFee() | number: '1.5-5' }} XLM</td>
                </tr>
                <tr class="fee-total">
                  <td><strong>Total</strong></td>
                  <td class="fee-val">
                    <strong>{{ totalCost() | number: '1.4-4' }} XLM</strong>
                  </td>
                </tr>
              </tbody>
            </table>
            <p class="fee-note">Gas estimate is approximate and may vary.</p>
          </section>

          @if (signingError()) {
            <p class="field-error" role="alert">{{ signingError() }}</p>
          }

          <div class="step-actions">
            <button class="btn btn-outline" type="button" (click)="goToStep(2)">← Back</button>
            <button
              class="btn btn-primary"
              type="button"
              (click)="submitRetirement()"
              [disabled]="submitting()"
            >
              {{ submitting() ? 'Signing & submitting…' : 'Sign & Retire →' }}
            </button>
          </div>
        </section>
      }

      <!-- ── Step 4: Sign & Celebrate ────────────────────────────────────── -->
      @if (currentStep() === 4) {
        <section class="step-panel celebrate" aria-labelledby="step4-title">
          <div class="confetti-wrap" aria-hidden="true">
            @for (p of confettiPieces; track p.id) {
              <span
                class="confetti-piece"
                [style.left]="p.left"
                [style.animation-delay]="p.delay"
                [style.background]="p.color"
              ></span>
            }
          </div>

          <div class="celebrate-content">
            <span class="celebrate-icon" aria-hidden="true">🌿</span>
            <h2 id="step4-title">Retirement Successful!</h2>
            <p class="celebrate-msg">
              You've retired
              <strong>{{ tonnesDisplay(totalSelectedTonnesRaw()) }} t CO₂e</strong> on behalf of
              <strong>{{ beneficiary }}</strong
              >.
            </p>

            @if (retirementId()) {
              <div class="cert-actions">
                <a class="btn btn-primary" [routerLink]="['/certificates', retirementId()]">
                  📄 View Certificate
                </a>
                <button
                  class="btn btn-outline"
                  type="button"
                  (click)="downloadCertificate()"
                  [disabled]="downloading()"
                >
                  {{ downloading() ? 'Downloading…' : '⬇ Download Certificate' }}
                </button>
              </div>
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .wizard {
        max-width: 680px;
        margin: 0 auto;
        padding: 1.5rem 1rem;
      }

      /* Progress bar */
      .wizard-progress {
        display: flex;
        align-items: center;
        margin-bottom: 2rem;
        overflow-x: auto;
      }

      .step-indicator {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.3rem;
        flex-shrink: 0;
      }

      .step-circle {
        width: 2rem;
        height: 2rem;
        border-radius: 50%;
        background: var(--border, #ddd);
        color: var(--text-muted, #555);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 0.85rem;
        transition:
          background 0.2s,
          color 0.2s;
      }

      .step-indicator.active .step-circle {
        background: var(--accent, #4caf50);
        color: #fff;
      }

      .step-indicator.done .step-circle {
        background: #2e7d32;
        color: #fff;
      }

      .step-label {
        font-size: 0.7rem;
        color: var(--text-muted, #666);
        white-space: nowrap;
      }

      .step-indicator.active .step-label {
        color: var(--text, #1a1a2e);
        font-weight: 600;
      }

      .step-connector {
        flex: 1;
        height: 2px;
        background: var(--border, #ddd);
        margin: 0 0.4rem;
        margin-top: -1.4rem;
        min-width: 20px;
      }

      .step-connector.done {
        background: #2e7d32;
      }

      /* Step panels */
      .step-panel {
        background: var(--surface, #f9f9f9);
        border: 1px solid var(--border, #ddd);
        border-radius: 8px;
        padding: 1.5rem;
      }

      .step-panel h2 {
        margin: 0 0 1.25rem;
        font-size: 1.1rem;
        color: var(--text, #1a1a2e);
      }

      /* Step 1 — credit list */
      .credit-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-bottom: 1rem;
        max-height: 320px;
        overflow-y: auto;
      }

      .credit-card {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        background: var(--bg, #fff);
        border: 1px solid var(--border, #ddd);
        border-radius: 6px;
        padding: 0.75rem 1rem;
        cursor: pointer;
        transition: border-color 0.15s;
      }

      .credit-card:hover {
        border-color: var(--accent, #4caf50);
      }

      .credit-card input[type='checkbox'] {
        width: 1rem;
        height: 1rem;
        accent-color: var(--accent, #4caf50);
        flex-shrink: 0;
      }

      .credit-info {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        min-width: 0;
      }

      .credit-id {
        font-family: monospace;
        font-size: 0.85rem;
        color: var(--text, #1a1a2e);
      }

      .credit-meta {
        font-size: 0.75rem;
        color: var(--text-muted, #666);
      }

      .credit-tonnes {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--accent, #4caf50);
      }

      .selection-summary {
        font-size: 0.85rem;
        color: var(--text-muted, #555);
        margin-bottom: 1rem;
      }

      /* Step 2 — forms */
      .form-field {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        margin-bottom: 1rem;
      }

      .field-label {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text, #1a1a2e);
      }

      .text-input {
        padding: 0.6rem 0.75rem;
        border: 1px solid var(--border, #ddd);
        border-radius: 6px;
        font-size: 0.9rem;
        background: var(--bg, #fff);
        color: var(--text, #1a1a2e);
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
      }

      .text-input:focus-visible {
        outline: 2px solid var(--accent, #4caf50);
        outline-offset: 2px;
      }

      .field-error {
        font-size: 0.8rem;
        color: #c62828;
      }

      /* Step 3 — preview */
      .preview-dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 0.3rem 1rem;
        margin-bottom: 1.25rem;
        font-size: 0.9rem;
      }

      .preview-dl dt {
        font-weight: 600;
        color: var(--text-muted, #555);
      }

      .preview-dl dd {
        margin: 0;
        color: var(--text, #1a1a2e);
      }

      /* Fee breakdown */
      .fee-breakdown {
        background: var(--bg, #fff);
        border: 1px solid var(--border, #ddd);
        border-radius: 6px;
        padding: 1rem;
        margin-bottom: 1rem;
      }

      .fee-breakdown h3 {
        margin: 0 0 0.75rem;
        font-size: 0.9rem;
        font-weight: 700;
        color: var(--text, #1a1a2e);
      }

      .fee-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.875rem;
      }

      .fee-table td {
        padding: 0.3rem 0;
        color: var(--text, #1a1a2e);
      }

      .fee-val {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      .fee-total td {
        border-top: 1px solid var(--border, #ddd);
        padding-top: 0.5rem;
        margin-top: 0.25rem;
      }

      .fee-note {
        font-size: 0.75rem;
        color: var(--text-muted, #888);
        margin: 0.5rem 0 0;
      }

      /* Actions */
      .step-actions {
        display: flex;
        gap: 0.75rem;
        justify-content: flex-end;
        flex-wrap: wrap;
        margin-top: 1.5rem;
      }

      .btn {
        padding: 0.6rem 1.4rem;
        border-radius: 6px;
        font-weight: 600;
        font-size: 0.9rem;
        cursor: pointer;
        border: 1px solid transparent;
        transition:
          background 0.15s,
          opacity 0.15s;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
      }

      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .btn-primary {
        background: var(--accent, #4caf50);
        color: #fff;
        border-color: var(--accent, #4caf50);
      }

      .btn-primary:hover:not(:disabled) {
        opacity: 0.88;
      }

      .btn-outline {
        background: transparent;
        color: var(--text, #1a1a2e);
        border-color: var(--border, #ddd);
      }

      .btn-outline:hover:not(:disabled) {
        background: var(--surface, #f5f5f5);
      }

      .btn:focus-visible {
        outline: 2px solid var(--accent, #4caf50);
        outline-offset: 2px;
      }

      /* Utility */
      .status {
        color: var(--text-muted, #888);
      }

      .mono {
        font-family: monospace;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      /* Step 4 — celebrate */
      .celebrate {
        position: relative;
        overflow: hidden;
        text-align: center;
      }

      .confetti-wrap {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }

      .confetti-piece {
        position: absolute;
        top: -10px;
        width: 8px;
        height: 8px;
        border-radius: 2px;
        animation: confettiFall 2.4s ease-in forwards;
      }

      @keyframes confettiFall {
        0% {
          transform: translateY(0) rotate(0deg);
          opacity: 1;
        }
        100% {
          transform: translateY(380px) rotate(540deg);
          opacity: 0;
        }
      }

      .celebrate-content {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        padding: 1rem 0;
      }

      .celebrate-icon {
        font-size: 3.5rem;
        line-height: 1;
      }

      .celebrate-msg {
        max-width: 400px;
        color: var(--text, #1a1a2e);
        font-size: 1rem;
      }

      .cert-actions {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        justify-content: center;
      }
    `,
  ],
})
export class RetireWizardComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly wallet = inject(StellarWalletService);
  private readonly api = inject(ApiService);
  readonly store = inject(CreditStore);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly currentStep = signal<WizardStep>(1);
  readonly selectedCredits = signal<CreditMetadata[]>([]);
  readonly submitting = signal(false);
  readonly downloading = signal(false);
  readonly signingError = signal<string | null>(null);
  readonly step2Submitted = signal(false);
  readonly retirementId = signal<string | null>(null);

  // Step 2 form controls
  beneficiary = '';
  readonly reasonControl = new FormControl<string>('', { validators: [Validators.required] });

  readonly steps = [
    { n: 1 as WizardStep, label: 'Select Credits' },
    { n: 2 as WizardStep, label: 'Beneficiary & Reason' },
    { n: 3 as WizardStep, label: 'Preview & Fees' },
    { n: 4 as WizardStep, label: 'Sign & Celebrate' },
  ];

  readonly confettiPieces = Array.from({ length: 30 }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    delay: `${Math.random() * 0.8}s`,
    color: ['#4caf50', '#1976d2', '#f57c00', '#7b1fa2', '#c62828', '#ffd700'][i % 6],
  }));

  async ngOnInit(): Promise<void> {
    const pk = this.wallet.publicKey();
    if (pk && this.auth.isAuthenticated()) {
      await this.store.loadByOwner(pk);
    }
  }

  // ── Computed ─────────────────────────────────────────────────────────────

  readonly activeCredits = computed(() => {
    const owner = this.wallet.publicKey();
    return this.store
      .credits()
      .filter((c) => c.status === CreditStatus.Active && c.owner === owner);
  });

  readonly totalSelectedTonnesRaw = computed(() =>
    this.selectedCredits()
      .reduce((s, c) => s + BigInt(c.tonnes), 0n)
      .toString(),
  );

  /** Approximate XLM credit cost (uses a 10 XLM/tonne placeholder rate). */
  readonly creditCost = computed(() => {
    const tonnes = Number(BigInt(this.totalSelectedTonnesRaw()) / 1_000_000n);
    return tonnes * 10;
  });

  readonly platformFee = computed(() => this.creditCost() * PLATFORM_FEE_PCT);
  readonly gasFee = computed(() => this.selectedCredits().length * XLM_PER_OP);
  readonly totalCost = computed(() => this.creditCost() + this.platformFee() + this.gasFee());

  // ── Helpers ───────────────────────────────────────────────────────────────

  stepAnnouncement(): string {
    const labels = [
      '',
      'Select Credits',
      'Beneficiary & Reason',
      'Preview & Fees',
      'Sign & Celebrate',
    ];
    return `Step ${this.currentStep()} of 4: ${labels[this.currentStep()]}`;
  }

  tonnesDisplay(raw: string): string {
    try {
      return (BigInt(raw) / 1_000_000n).toString();
    } catch {
      return '0';
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

  goToStep(step: WizardStep): void {
    this.currentStep.set(step);
  }

  submitStep2(): void {
    this.step2Submitted.set(true);
    if (!this.beneficiary.trim() || this.reasonControl.invalid) return;
    this.goToStep(3);
  }

  async submitRetirement(): Promise<void> {
    const credits = this.selectedCredits();
    const pk = this.wallet.publicKey();
    const token = this.auth.token();
    if (!credits.length || !pk || !token) return;

    this.submitting.set(true);
    this.signingError.set(null);

    try {
      if (credits.length === 1) {
        const { retirementId } = await firstValueFrom(
          this.api.retireCredit(
            {
              buyerPublicKey: pk,
              creditId: credits[0].id,
              tonnes: credits[0].tonnes,
              reason: this.reasonControl.value ?? '',
            },
            token,
          ),
        );
        this.retirementId.set(retirementId);
      } else {
        const { succeeded } = await firstValueFrom(
          this.api.batchRetire(
            {
              buyerPublicKey: pk,
              creditIds: credits.map((c) => c.id),
              tonnes: credits.map((c) => c.tonnes),
              reason: this.reasonControl.value ?? '',
            },
            token,
          ),
        );
        if (succeeded.length > 0) this.retirementId.set(succeeded[0]);
      }

      for (const c of credits) {
        this.store.loadOne(c.id).catch(() => {});
      }
      this.goToStep(4);
    } catch (err) {
      const walletErr = normalizeWalletError(err);
      this.signingError.set(walletErr.displayMessage);
    } finally {
      this.submitting.set(false);
    }
  }

  async downloadCertificate(): Promise<void> {
    const id = this.retirementId();
    const token = this.auth.token();
    if (!id || !token) return;
    this.downloading.set(true);
    try {
      const blob = await firstValueFrom(this.api.downloadCertificate(id, token));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `certificate-${id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      this.toast.show('Certificate download failed.', 'error');
    } finally {
      this.downloading.set(false);
    }
  }
}
