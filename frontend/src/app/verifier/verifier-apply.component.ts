import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../core/services/api.service';
import { ToastService } from '../core/services/toast.service';

const METHODOLOGY_OPTIONS = ['Verra VCS', 'Gold Standard', 'CAR', 'ACR', 'Plan Vivo'];
const GEOGRAPHY_OPTIONS = ['Africa', 'Asia-Pacific', 'Europe', 'Latin America', 'North America'];

@Component({
  selector: 'app-verifier-apply',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="verifier-apply">
      <h1 class="page-title">Become a Verifier</h1>
      <p class="page-desc">
        Apply to join the verifier registry. You will need to commit a minimum stake and upload
        supporting documents.
      </p>

      @if (error()) {
        <p class="alert alert--error" role="alert">{{ error() }}</p>
      }
      @if (success()) {
        <p class="alert alert--success" role="status">{{ success() }}</p>
      }

      <form class="apply-form" (ngSubmit)="submit()" #form="ngForm">
        <div class="form-field">
          <label class="field-label" for="apply-address">Stellar Address</label>
          <input
            id="apply-address"
            class="text-input"
            type="text"
            placeholder="G…"
            [(ngModel)]="address"
            name="address"
            required
          />
        </div>

        <div class="form-field">
          <label class="field-label" for="apply-name">Display Name</label>
          <input
            id="apply-name"
            class="text-input"
            type="text"
            placeholder="Your name or organization"
            [(ngModel)]="name"
            name="name"
            required
          />
        </div>

        <fieldset class="capability-group">
          <legend>Methodologies</legend>
          @for (m of methodOptions; track m) {
            <label class="checkbox-label">
              <input
                type="checkbox"
                [checked]="selectedMethods().includes(m)"
                (change)="toggleMethod(m)"
              />
              {{ m }}
            </label>
          }
        </fieldset>

        <fieldset class="capability-group">
          <legend>Geographies</legend>
          @for (g of geoOptions; track g) {
            <label class="checkbox-label">
              <input
                type="checkbox"
                [checked]="selectedGeos().includes(g)"
                (change)="toggleGeo(g)"
              />
              {{ g }}
            </label>
          }
        </fieldset>

        <div class="form-field">
          <label class="field-label" for="apply-docs">Documents (IPFS CID)</label>
          <input
            id="apply-docs"
            class="text-input"
            type="text"
            placeholder="Qm… or ipfs://…"
            [(ngModel)]="documentsCid"
            name="documentsCid"
            required
          />
          <span class="field-hint">Upload documents to IPFS and paste the CID here.</span>
        </div>

        <div class="form-field">
          <label class="field-label" for="apply-stake-token">Stake Token</label>
          <input
            id="apply-stake-token"
            class="text-input"
            type="text"
            placeholder="Native (XLM) or SAC contract ID"
            [(ngModel)]="stakeToken"
            name="stakeToken"
            required
          />
        </div>

        <div class="form-field">
          <label class="field-label" for="apply-stake-amount">Stake Amount (XLM)</label>
          <input
            id="apply-stake-amount"
            class="text-input"
            type="number"
            min="0"
            step="1"
            placeholder="Minimum 1000 XLM"
            [(ngModel)]="stakeAmountXlm"
            name="stakeAmountXlm"
            required
          />
          @if (stakeAmountXlm !== null && stakeAmountXlm < 1000) {
            <span class="field-error">Minimum stake is 1000 XLM.</span>
          }
        </div>

        <div class="stake-preview" *ngIf="stakeAmountXlm !== null && stakeAmountXlm >= 1000">
          <h3>Stake Commitment Preview</h3>
          <p>
            You are committing <strong>{{ stakeAmountXlm }} XLM</strong> as verifier stake. This
            amount will be locked on-chain and subject to slashing if you approve fraudulent
            credits.
          </p>
        </div>

        <div class="form-actions">
          <button
            class="btn btn-primary"
            type="submit"
            [disabled]="
              submitting() || form.invalid || (stakeAmountXlm !== null && stakeAmountXlm < 1000)
            "
          >
            {{ submitting() ? 'Submitting…' : 'Submit Application' }}
          </button>
          <button type="button" class="btn btn-ghost" (click)="router.navigate(['/dashboard'])">
            Cancel
          </button>
        </div>
      </form>
    </div>
  `,
  styles: [
    `
      .verifier-apply {
        max-width: 640px;
        margin: 2rem auto;
        padding: 0 1rem;
      }
      .page-title {
        margin: 0 0 0.5rem;
        font-size: 1.5rem;
      }
      .page-desc {
        margin: 0 0 1.5rem;
        color: #555;
        font-size: 0.95rem;
      }
      .apply-form {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }
      .form-field {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .field-label {
        font-size: 0.85rem;
        font-weight: 600;
      }
      .text-input {
        padding: 0.55rem 0.75rem;
        border: 1px solid #bbb;
        border-radius: 6px;
        font-size: 0.95rem;
        font-family: monospace;
      }
      .text-input:focus {
        outline: 2px solid #4caf50;
        border-color: transparent;
      }
      .field-hint {
        font-size: 0.8rem;
        color: #666;
      }
      .field-error {
        font-size: 0.8rem;
        color: #c62828;
      }
      .capability-group {
        border: 1px solid #ddd;
        border-radius: 6px;
        padding: 0.75rem 1rem;
      }
      .capability-group legend {
        font-size: 0.85rem;
        font-weight: 600;
        padding: 0 0.25rem;
      }
      .checkbox-label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
        margin: 0.3rem 0;
        cursor: pointer;
      }
      .stake-preview {
        background: #e3f2fd;
        border: 1px solid #90caf9;
        border-radius: 8px;
        padding: 1rem;
      }
      .stake-preview h3 {
        margin: 0 0 0.5rem;
        font-size: 1rem;
      }
      .stake-preview p {
        margin: 0;
        font-size: 0.9rem;
      }
      .form-actions {
        display: flex;
        gap: 0.75rem;
        justify-content: flex-end;
        margin-top: 0.5rem;
      }
      .btn {
        padding: 0.55rem 1.25rem;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: 0.9rem;
        font-weight: 500;
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-primary {
        background: #4caf50;
        color: #fff;
      }
      .btn-ghost {
        background: transparent;
        border: 1px solid #bbb;
        color: #444;
      }
      .alert {
        padding: 0.75rem 1rem;
        border-radius: 6px;
        font-size: 0.875rem;
        margin-bottom: 1rem;
      }
      .alert--error {
        background: #ffebee;
        color: #c62828;
        border: 1px solid #ef9a9a;
      }
      .alert--success {
        background: #e8f5e9;
        color: #2e7d32;
        border: 1px solid #a5d6a7;
      }
    `,
  ],
})
export class VerifierApplyComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  public readonly router = inject(Router);

  readonly methodOptions = METHODOLOGY_OPTIONS;
  readonly geoOptions = GEOGRAPHY_OPTIONS;

  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);
  readonly selectedMethods = signal<string[]>([]);
  readonly selectedGeos = signal<string[]>([]);

  address = '';
  name = '';
  documentsCid = '';
  stakeToken = '';
  stakeAmountXlm: number | null = null;

  toggleMethod(m: string): void {
    this.selectedMethods.update((list) =>
      list.includes(m) ? list.filter((x) => x !== m) : [...list, m],
    );
  }

  toggleGeo(g: string): void {
    this.selectedGeos.update((list) =>
      list.includes(g) ? list.filter((x) => x !== g) : [...list, g],
    );
  }

  async submit(): Promise<void> {
    this.error.set(null);
    this.success.set(null);
    if (
      !this.address ||
      !this.name ||
      !this.documentsCid ||
      !this.stakeToken ||
      this.stakeAmountXlm === null
    ) {
      this.error.set('Please fill in all required fields.');
      return;
    }
    if (this.stakeAmountXlm < 1000) {
      this.error.set('Minimum stake is 1000 XLM.');
      return;
    }

    this.submitting.set(true);
    try {
      const amountStroops = Math.round(this.stakeAmountXlm * 10_000_000).toString();
      await firstValueFrom(
        this.api.submitVerifierApplication({
          address: this.address,
          name: this.name,
          capabilities: [...this.selectedMethods(), ...this.selectedGeos()],
          documentsCid: this.documentsCid,
          stakeToken: this.stakeToken,
          stakeAmount: amountStroops,
        }),
      );
      this.success.set('Application submitted successfully. You can check the status below.');
      this.toast.show('Verifier application submitted.', 'success');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to submit application.');
    } finally {
      this.submitting.set(false);
    }
  }
}
