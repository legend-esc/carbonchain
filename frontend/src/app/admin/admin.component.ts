import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AdminVerifiersComponent } from './admin-verifiers.component';
import { AdminService, ExpireCreditResult, ResolveDisputeResult, SlashVerifierResult } from './admin.service';
import { AuthService } from '../core/services/auth.service';

/** Map of contract error codes to user-friendly messages for admin actions. */
const ADMIN_CONTRACT_ERRORS: Record<string, string> = {
  '100': 'Credit not found.',
  '101': 'Credit is already retired and cannot be expired.',
  '102': 'Credit is already expired.',
  '109': 'Insufficient admin privileges to perform this action.',
  '110': 'Dispute not found.',
  '111': 'Dispute is already resolved.',
  '112': 'Verifier not found.',
  '113': 'Verifier has insufficient stake to slash.',
  '114': 'Slash amount exceeds verifier stake.',
  '123': 'Contract is currently paused. Try again later.',
};

function mapAdminError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  for (const [code, friendly] of Object.entries(ADMIN_CONTRACT_ERRORS)) {
    if (msg.includes(code)) return friendly;
  }
  return msg || 'An unexpected error occurred. Please try again.';
}

type AdminTab = 'verifiers' | 'expire' | 'dispute' | 'slash';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, AdminVerifiersComponent],
  template: `
    <main class="admin-panel">
      <h1>Admin Panel</h1>

      <!-- Tab navigation -->
      <nav class="tab-nav" role="tablist" aria-label="Admin sections">
        <button
          role="tab"
          [attr.aria-selected]="activeTab() === 'verifiers'"
          [class.tab--active]="activeTab() === 'verifiers'"
          class="tab-btn"
          (click)="setTab('verifiers')"
        >
          Verifiers
        </button>
        <button
          role="tab"
          [attr.aria-selected]="activeTab() === 'expire'"
          [class.tab--active]="activeTab() === 'expire'"
          class="tab-btn"
          (click)="setTab('expire')"
        >
          Expire Credit
        </button>
        <button
          role="tab"
          [attr.aria-selected]="activeTab() === 'dispute'"
          [class.tab--active]="activeTab() === 'dispute'"
          class="tab-btn"
          (click)="setTab('dispute')"
        >
          Resolve Dispute
        </button>
        <button
          role="tab"
          [attr.aria-selected]="activeTab() === 'slash'"
          [class.tab--active]="activeTab() === 'slash'"
          class="tab-btn"
          (click)="setTab('slash')"
        >
          Slash Verifier
        </button>
      </nav>

      <!-- Verifiers tab -->
      @if (activeTab() === 'verifiers') {
        <app-admin-verifiers />
      }

      <!-- Expire Credit tab -->
      @if (activeTab() === 'expire') {
        <section class="admin-section" aria-label="Expire credit">
          <h2>Expire Credit</h2>
          <p class="help-text">
            Force-expire a credit to prevent further transfers or retirements.
            This action is irreversible and recorded on-chain.
          </p>

          @if (expireError()) {
            <p class="alert alert--error" role="alert">{{ expireError() }}</p>
          }
          @if (expireResult()) {
            <div class="alert alert--success" role="status">
              <strong>Credit expired successfully.</strong><br />
              Credit ID: <span class="mono">{{ expireResult()!.creditId }}</span><br />
              Transaction: <span class="mono">{{ expireResult()!.txHash || 'pending' }}</span>
            </div>
          }

          @if (!expireResult()) {
            <form class="action-form" (ngSubmit)="confirmExpire()" #expireForm="ngForm">
              <div class="field-group">
                <label class="field-label" for="expire-credit-id">Credit ID</label>
                <input
                  id="expire-credit-id"
                  class="text-input"
                  type="text"
                  placeholder="Hex-encoded credit ID"
                  [(ngModel)]="expireCreditId"
                  name="expireCreditId"
                  required
                  #expireCreditIdField="ngModel"
                />
                @if (expireCreditIdField.invalid && expireCreditIdField.touched) {
                  <span class="field-error">Credit ID is required.</span>
                }
              </div>

              <div class="field-group">
                <label class="field-label" for="expire-reason">Reason</label>
                <textarea
                  id="expire-reason"
                  class="text-input textarea"
                  placeholder="Reason for expiry (stored on-chain)"
                  [(ngModel)]="expireReason"
                  name="expireReason"
                  required
                  rows="3"
                  #expireReasonField="ngModel"
                ></textarea>
                @if (expireReasonField.invalid && expireReasonField.touched) {
                  <span class="field-error">Reason is required.</span>
                }
              </div>

              <div class="form-actions">
                <button
                  type="submit"
                  class="btn btn-danger"
                  [disabled]="expireLoading() || expireForm.invalid"
                >
                  {{ expireLoading() ? 'Processing…' : 'Expire Credit' }}
                </button>
              </div>
            </form>
          } @else {
            <button class="btn btn-ghost" (click)="resetExpire()">Expire Another</button>
          }
        </section>
      }

      <!-- Resolve Dispute tab -->
      @if (activeTab() === 'dispute') {
        <section class="admin-section" aria-label="Resolve dispute">
          <h2>Resolve Dispute</h2>
          <p class="help-text">
            Close an open on-chain dispute by providing a resolution.
            The resolution text is permanently recorded on-chain.
          </p>

          @if (disputeError()) {
            <p class="alert alert--error" role="alert">{{ disputeError() }}</p>
          }
          @if (disputeResult()) {
            <div class="alert alert--success" role="status">
              <strong>Dispute resolved successfully.</strong><br />
              Dispute ID: <span class="mono">{{ disputeResult()!.disputeId }}</span><br />
              Resolution: {{ disputeResult()!.resolution }}<br />
              Transaction: <span class="mono">{{ disputeResult()!.txHash || 'pending' }}</span>
            </div>
          }

          @if (!disputeResult()) {
            <form class="action-form" (ngSubmit)="confirmDispute()" #disputeForm="ngForm">
              <div class="field-group">
                <label class="field-label" for="dispute-id">Dispute ID</label>
                <input
                  id="dispute-id"
                  class="text-input"
                  type="text"
                  placeholder="On-chain dispute ID"
                  [(ngModel)]="disputeId"
                  name="disputeId"
                  required
                  #disputeIdField="ngModel"
                />
                @if (disputeIdField.invalid && disputeIdField.touched) {
                  <span class="field-error">Dispute ID is required.</span>
                }
              </div>

              <div class="field-group">
                <label class="field-label" for="dispute-resolution">Resolution</label>
                <textarea
                  id="dispute-resolution"
                  class="text-input textarea"
                  placeholder="Resolution outcome (stored on-chain)"
                  [(ngModel)]="disputeResolution"
                  name="disputeResolution"
                  required
                  rows="4"
                  #disputeResolutionField="ngModel"
                ></textarea>
                @if (disputeResolutionField.invalid && disputeResolutionField.touched) {
                  <span class="field-error">Resolution text is required.</span>
                }
              </div>

              <div class="field-group">
                <label class="field-label">Evidence (read-only)</label>
                <div class="evidence-display">
                  @if (disputeEvidence()) {
                    <pre class="evidence-text">{{ disputeEvidence() }}</pre>
                  } @else {
                    <p class="status">Enter a dispute ID above to load evidence.</p>
                  }
                </div>
              </div>

              <div class="form-actions">
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="disputeLoading() || disputeForm.invalid"
                >
                  {{ disputeLoading() ? 'Processing…' : 'Resolve Dispute' }}
                </button>
              </div>
            </form>
          } @else {
            <button class="btn btn-ghost" (click)="resetDispute()">Resolve Another</button>
          }
        </section>
      }

      <!-- Slash Verifier tab -->
      @if (activeTab() === 'slash') {
        <section class="admin-section" aria-label="Slash verifier">
          <h2>Slash Verifier</h2>
          <p class="help-text">
            Penalise a misbehaving verifier by slashing part of their staked balance.
            Slashed funds enter an unbonding period before being redistributed.
          </p>

          <div class="alert alert--warning" role="note">
            ⚠️ <strong>This action initiates an unbonding period</strong> during which
            the verifier cannot participate in approvals. Ensure you have reviewed the
            evidence before proceeding.
          </div>

          @if (slashError()) {
            <p class="alert alert--error" role="alert">{{ slashError() }}</p>
          }
          @if (slashResult()) {
            <div class="alert alert--success" role="status">
              <strong>Verifier slashed successfully.</strong><br />
              Verifier: <span class="mono">{{ slashResult()!.verifierAddress }}</span><br />
              Amount slashed: {{ slashResult()!.amount }} stroops<br />
              Unbonding period: {{ slashResult()!.unbondingPeriodDays }} days<br />
              Transaction: <span class="mono">{{ slashResult()!.txHash || 'pending' }}</span>
            </div>
          }

          @if (!slashResult()) {
            <form class="action-form" (ngSubmit)="confirmSlash()" #slashForm="ngForm">
              <div class="field-group">
                <label class="field-label" for="slash-address">Verifier Address</label>
                <input
                  id="slash-address"
                  class="text-input"
                  type="text"
                  placeholder="G… Stellar public key"
                  [(ngModel)]="slashVerifierAddress"
                  name="slashVerifierAddress"
                  required
                  #slashAddressField="ngModel"
                />
                @if (slashAddressField.invalid && slashAddressField.touched) {
                  <span class="field-error">Verifier address is required.</span>
                }
              </div>

              <div class="field-group">
                <label class="field-label" for="slash-amount">
                  Slash Amount (stroops — 1 XLM = 10,000,000 stroops)
                </label>
                <input
                  id="slash-amount"
                  class="text-input"
                  type="number"
                  min="1"
                  placeholder="e.g. 10000000"
                  [(ngModel)]="slashAmount"
                  name="slashAmount"
                  required
                  #slashAmountField="ngModel"
                />
                @if (slashAmountField.invalid && slashAmountField.touched) {
                  <span class="field-error">Slash amount must be a positive integer.</span>
                }
              </div>

              <div class="field-group">
                <label class="field-label">Unbonding Notice</label>
                <p class="unbonding-notice">
                  The verifier will enter a <strong>30-day unbonding period</strong> following the
                  slash. During this period they cannot approve credits or process MRV data.
                  After unbonding, slashed funds are redistributed to the protocol treasury.
                </p>
              </div>

              <div class="form-actions">
                <button
                  type="submit"
                  class="btn btn-danger"
                  [disabled]="slashLoading() || slashForm.invalid"
                >
                  {{ slashLoading() ? 'Processing…' : 'Slash Verifier' }}
                </button>
              </div>
            </form>
          } @else {
            <button class="btn btn-ghost" (click)="resetSlash()">Slash Another</button>
          }
        </section>
      }

      <!-- Confirm Dialog overlay -->
      @if (showConfirmDialog()) {
        <div class="modal-backdrop" (click)="cancelConfirm()" role="presentation">
          <div
            class="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-desc"
            (click)="$event.stopPropagation()"
          >
            <h2 id="confirm-title" class="modal-title">Confirm Action</h2>
            <p id="confirm-desc" class="modal-desc">{{ confirmMessage() }}</p>
            <div class="modal-actions">
              <button class="btn btn-danger" (click)="executeConfirmedAction()">
                {{ confirmLoading() ? 'Processing…' : 'Confirm' }}
              </button>
              <button class="btn btn-ghost" (click)="cancelConfirm()">Cancel</button>
            </div>
          </div>
        </div>
      }
    </main>
  `,
  styles: [`
    .admin-panel {
      padding: 2rem;
      max-width: 860px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 1.5rem;
    }
    .tab-nav {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      border-bottom: 2px solid #e0e0e0;
      padding-bottom: 0;
    }
    .tab-btn {
      padding: 0.5rem 1.25rem;
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 0.9rem;
      color: #555;
      border-bottom: 3px solid transparent;
      margin-bottom: -2px;
      border-radius: 4px 4px 0 0;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab-btn:hover {
      color: #1976d2;
    }
    .tab-btn.tab--active {
      color: #1976d2;
      border-bottom-color: #1976d2;
      font-weight: 600;
    }
    .admin-section {
      background: #fff;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 1.5rem;
    }
    h2 {
      margin: 0 0 0.5rem;
      font-size: 1.1rem;
    }
    .help-text {
      font-size: 0.875rem;
      color: #555;
      margin-bottom: 1.25rem;
    }
    .action-form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .field-group {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
    }
    .field-label {
      font-size: 0.875rem;
      font-weight: 600;
      color: #444;
    }
    .text-input {
      padding: 0.5rem 0.75rem;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-size: 0.9rem;
      width: 100%;
      box-sizing: border-box;
      font-family: inherit;
    }
    .text-input:focus {
      outline: 2px solid #1976d2;
      border-color: transparent;
    }
    .textarea {
      resize: vertical;
      min-height: 80px;
    }
    .field-error {
      color: #c62828;
      font-size: 0.8rem;
    }
    .form-actions {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }
    .btn {
      padding: 0.5rem 1.25rem;
      border-radius: 6px;
      cursor: pointer;
      border: none;
      font-size: 0.9rem;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-primary { background: #1976d2; color: #fff; }
    .btn-danger { background: #e53935; color: #fff; }
    .btn-ghost { background: transparent; color: #666; border: 1px solid #ccc; }
    .alert {
      padding: 0.75rem 1rem;
      border-radius: 6px;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    .alert--error { background: #ffebee; color: #c62828; border: 1px solid #ef9a9a; }
    .alert--success { background: #e8f5e9; color: #1b5e20; border: 1px solid #a5d6a7; line-height: 1.8; }
    .alert--warning { background: #fff8e1; color: #e65100; border: 1px solid #ffcc02; margin-bottom: 1.25rem; }
    .mono { font-family: monospace; word-break: break-all; }
    .status { color: #888; font-size: 0.875rem; }
    .evidence-display {
      background: #f5f5f5;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 0.75rem;
      min-height: 60px;
    }
    .evidence-text {
      margin: 0;
      font-size: 0.8rem;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .unbonding-notice {
      margin: 0;
      font-size: 0.875rem;
      color: #555;
      background: #fff8e1;
      border: 1px solid #ffcc02;
      padding: 0.75rem;
      border-radius: 4px;
    }
    /* Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal {
      background: #fff;
      border-radius: 8px;
      padding: 2rem;
      max-width: 480px;
      width: 90%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    }
    .modal-title {
      margin: 0 0 1rem;
      font-size: 1.1rem;
    }
    .modal-desc {
      font-size: 0.9rem;
      color: #444;
      margin-bottom: 1.5rem;
      line-height: 1.6;
    }
    .modal-actions {
      display: flex;
      gap: 0.75rem;
    }
  `],
})
export class AdminComponent {
  private readonly adminService = inject(AdminService);
  protected readonly auth = inject(AuthService);

  readonly activeTab = signal<AdminTab>('verifiers');

  setTab(tab: AdminTab): void {
    this.activeTab.set(tab);
  }

  // ── Confirm Dialog State ───────────────────────────────────────────────────

  readonly showConfirmDialog = signal(false);
  readonly confirmMessage = signal('');
  readonly confirmLoading = signal(false);
  private pendingAction: (() => Promise<void>) | null = null;

  private openConfirm(message: string, action: () => Promise<void>): void {
    this.confirmMessage.set(message);
    this.pendingAction = action;
    this.showConfirmDialog.set(true);
  }

  async executeConfirmedAction(): Promise<void> {
    if (!this.pendingAction) return;
    this.confirmLoading.set(true);
    try {
      await this.pendingAction();
    } finally {
      this.confirmLoading.set(false);
      this.showConfirmDialog.set(false);
      this.pendingAction = null;
    }
  }

  cancelConfirm(): void {
    this.showConfirmDialog.set(false);
    this.pendingAction = null;
    this.confirmLoading.set(false);
  }

  // ── Expire Credit ──────────────────────────────────────────────────────────

  expireCreditId = '';
  expireReason = '';
  readonly expireLoading = signal(false);
  readonly expireError = signal<string | null>(null);
  readonly expireResult = signal<ExpireCreditResult | null>(null);

  confirmExpire(): void {
    this.openConfirm(
      `You are about to expire credit "${this.expireCreditId}". ` +
        `Reason: "${this.expireReason}". ` +
        `This action is irreversible and recorded on-chain. Proceed?`,
      () => this.doExpire(),
    );
  }

  private async doExpire(): Promise<void> {
    const token = this.auth.token();
    if (!token) {
      this.expireError.set('You must be logged in as admin.');
      return;
    }
    this.expireLoading.set(true);
    this.expireError.set(null);
    try {
      // Build → sign → submit (service handles Soroban transaction construction)
      const result = await firstValueFrom(
        this.adminService.expireCredit(this.expireCreditId, this.expireReason, token),
      );
      this.expireResult.set(result);
    } catch (err) {
      this.expireError.set(mapAdminError(err));
    } finally {
      this.expireLoading.set(false);
    }
  }

  resetExpire(): void {
    this.expireCreditId = '';
    this.expireReason = '';
    this.expireError.set(null);
    this.expireResult.set(null);
  }

  // ── Resolve Dispute ────────────────────────────────────────────────────────

  disputeId = '';
  disputeResolution = '';
  readonly disputeLoading = signal(false);
  readonly disputeError = signal<string | null>(null);
  readonly disputeResult = signal<ResolveDisputeResult | null>(null);
  readonly disputeEvidence = signal<string | null>(null);

  confirmDispute(): void {
    this.openConfirm(
      `You are about to resolve dispute "${this.disputeId}" with resolution: ` +
        `"${this.disputeResolution}". This outcome is permanently recorded on-chain. Proceed?`,
      () => this.doResolveDispute(),
    );
  }

  private async doResolveDispute(): Promise<void> {
    const token = this.auth.token();
    if (!token) {
      this.disputeError.set('You must be logged in as admin.');
      return;
    }
    this.disputeLoading.set(true);
    this.disputeError.set(null);
    try {
      // Build → sign → submit (service handles Soroban transaction construction)
      const result = await firstValueFrom(
        this.adminService.resolveDispute(this.disputeId, this.disputeResolution, token),
      );
      this.disputeResult.set(result);
    } catch (err) {
      this.disputeError.set(mapAdminError(err));
    } finally {
      this.disputeLoading.set(false);
    }
  }

  resetDispute(): void {
    this.disputeId = '';
    this.disputeResolution = '';
    this.disputeEvidence.set(null);
    this.disputeError.set(null);
    this.disputeResult.set(null);
  }

  // ── Slash Verifier ─────────────────────────────────────────────────────────

  slashVerifierAddress = '';
  slashAmount: number | null = null;
  readonly slashLoading = signal(false);
  readonly slashError = signal<string | null>(null);
  readonly slashResult = signal<SlashVerifierResult | null>(null);

  confirmSlash(): void {
    this.openConfirm(
      `You are about to slash verifier "${this.slashVerifierAddress}" for ` +
        `${this.slashAmount?.toLocaleString()} stroops. ` +
        `This will trigger a 30-day unbonding period. This action cannot be undone. Proceed?`,
      () => this.doSlash(),
    );
  }

  private async doSlash(): Promise<void> {
    const token = this.auth.token();
    if (!token) {
      this.slashError.set('You must be logged in as admin.');
      return;
    }
    if (this.slashAmount === null || this.slashAmount <= 0) {
      this.slashError.set('Slash amount must be a positive integer.');
      return;
    }
    this.slashLoading.set(true);
    this.slashError.set(null);
    try {
      // Build → sign → submit (service handles Soroban transaction construction)
      const result = await firstValueFrom(
        this.adminService.slashVerifier(
          this.slashVerifierAddress,
          String(this.slashAmount),
          token,
        ),
      );
      this.slashResult.set(result);
    } catch (err) {
      this.slashError.set(mapAdminError(err));
    } finally {
      this.slashLoading.set(false);
    }
  }

  resetSlash(): void {
    this.slashVerifierAddress = '';
    this.slashAmount = null;
    this.slashError.set(null);
    this.slashResult.set(null);
  }
}
