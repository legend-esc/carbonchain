import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AdminVerifiersComponent } from './admin-verifiers.component';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { ToastService } from '../core/services/toast.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, AdminVerifiersComponent],
  template: `
    <main class="admin-panel">
      <h1 class="panel-title">Admin Panel</h1>

      <!-- ── Verifier Management ──────────────────────────────────────────── -->
      <section class="panel-section">
        <app-admin-verifiers />
      </section>

      <!-- ── Methodology Registration ────────────────────────────────────── -->
      <section class="panel-section">
        <h2 class="section-title">Methodology Registration</h2>
        <p class="section-description">
          Register a new carbon credit methodology. Credits submitted with this methodology name
          will pass validation on the contract.
        </p>

        @if (methodologyError()) {
          <p class="alert alert--error" role="alert">{{ methodologyError() }}</p>
        }

        <div class="form-row">
          <div class="form-field">
            <label class="field-label" for="method-name">Methodology Name</label>
            <input
              id="method-name"
              class="text-input"
              type="text"
              placeholder="e.g. VCS, Gold Standard, CDM"
              [(ngModel)]="methodologyName"
              [disabled]="isRegisteringMethodology()"
            />
          </div>
          <div class="form-field form-field--grow">
            <label class="field-label" for="method-desc">Description</label>
            <input
              id="method-desc"
              class="text-input"
              type="text"
              placeholder="Short description of the methodology"
              [(ngModel)]="methodologyDescription"
              [disabled]="isRegisteringMethodology()"
            />
          </div>
          <button
            class="btn btn-primary btn-self-end"
            (click)="submitMethodology()"
            [disabled]="
              isRegisteringMethodology() ||
              !methodologyName.trim() ||
              !methodologyDescription.trim()
            "
          >
            {{ isRegisteringMethodology() ? 'Registering…' : 'Register' }}
          </button>
        </div>

        @if (registeredMethodologies().length > 0) {
          <ul class="method-list" aria-label="Registered methodologies">
            @for (m of registeredMethodologies(); track m.name) {
              <li class="method-item">
                <strong>{{ m.name }}</strong
                >: {{ m.description }}
              </li>
            }
          </ul>
        }
      </section>

      <!-- ── Required Approvals ───────────────────────────────────────────── -->
      <section class="panel-section">
        <h2 class="section-title">Required Approvals</h2>
        <p class="section-description">
          Set the minimum number of verifier approvals needed to mint a credit. Valid range: 1 –
          {{ maxApprovals() }}.
        </p>

        @if (approvalsError()) {
          <p class="alert alert--error" role="alert">{{ approvalsError() }}</p>
        }

        <div class="slider-row">
          <label class="field-label" for="approvals-slider">
            Required approvals: <strong>{{ requiredApprovals() }}</strong>
          </label>
          <input
            id="approvals-slider"
            class="slider"
            type="range"
            [min]="1"
            [max]="maxApprovals()"
            [value]="requiredApprovals()"
            (input)="onSliderChange($event)"
            [disabled]="isSavingApprovals()"
            aria-label="Required approvals slider"
          />
          <button
            class="btn btn-primary"
            (click)="saveRequiredApprovals()"
            [disabled]="isSavingApprovals()"
          >
            {{ isSavingApprovals() ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </section>

      <!-- ── Staking Management ──────────────────────────────────────────── -->
      <section class="panel-section">
        <h2 class="section-title">Verifier Staking</h2>
        <p class="section-description">
          Configure the minimum stake required to register a verifier, look up locked balances, and
          slash verifiers who approved fraudulent credits.
        </p>

        <!-- Current minimum stake display -->
        <div class="stake-info">
          <span class="field-label">Current minimum stake:</span>
          @if (minStakeLoading()) {
            <span class="status-loading" aria-live="polite">Loading…</span>
          } @else {
            <strong aria-label="Minimum stake: {{ formatStroops(minStake()) }} XLM">
              {{ formatStroops(minStake()) }} XLM
            </strong>
            <span class="stake-sub">({{ minStake() }} stroops)</span>
          }
        </div>

        <!-- Set minimum stake -->
        @if (stakeError()) {
          <p class="alert alert--error" role="alert">{{ stakeError() }}</p>
        }

        <div class="form-row">
          <div class="form-field">
            <label class="field-label" for="min-stake-input">New minimum stake (XLM)</label>
            <input
              id="min-stake-input"
              class="text-input"
              type="number"
              min="0"
              step="100"
              placeholder="e.g. 1000"
              [(ngModel)]="newMinStakeXlm"
              [disabled]="isSavingMinStake()"
              aria-label="New minimum stake in XLM"
            />
          </div>
          <button
            class="btn btn-primary btn-self-end"
            (click)="saveMinStake()"
            [disabled]="isSavingMinStake() || newMinStakeXlm === null"
          >
            {{ isSavingMinStake() ? 'Saving…' : 'Update Min Stake' }}
          </button>
        </div>

        <!-- Check verifier stake balance -->
        <div class="form-row" style="margin-top: 1.5rem;">
          <div class="form-field form-field--grow">
            <label class="field-label" for="stake-check-address">Verifier address</label>
            <input
              id="stake-check-address"
              class="text-input"
              type="text"
              placeholder="G…"
              [(ngModel)]="stakeCheckAddress"
              [disabled]="isCheckingStake()"
              aria-label="Verifier address to check stake balance"
            />
          </div>
          <button
            class="btn btn-ghost btn-self-end"
            (click)="checkVerifierStake()"
            [disabled]="isCheckingStake() || !stakeCheckAddress.trim()"
          >
            {{ isCheckingStake() ? 'Checking…' : 'Check Stake' }}
          </button>
        </div>

        @if (verifierStakeResult()) {
          <div class="stake-result" role="region" aria-label="Stake check result">
            <span class="field-label">Locked stake:</span>
            <strong>{{ formatStroops(verifierStakeResult()!.stake) }} XLM</strong>
            <span class="stake-sub">({{ verifierStakeResult()!.stake }} stroops)</span>
            @if (BigInt(verifierStakeResult()!.stake) < BigInt(minStake())) {
              <span
                class="badge badge--warn"
                title="Below minimum — this verifier cannot be registered until they deposit more stake"
              >
                ⚠ Below minimum
              </span>
            } @else {
              <span class="badge badge--ok">✔ Meets minimum</span>
            }
          </div>
        }

        <!-- Slash verifier -->
        <h3 class="subsection-title">Slash Verifier Stake</h3>
        <p class="section-description section-description--sm">
          Apply a 10% penalty to a verifier's locked stake when they approved a credit that was
          later found to be fraudulent. This action is irreversible.
        </p>

        @if (slashError()) {
          <p class="alert alert--error" role="alert">{{ slashError() }}</p>
        }

        <div class="form-row">
          <div class="form-field form-field--grow">
            <label class="field-label" for="slash-address">Verifier address</label>
            <input
              id="slash-address"
              class="text-input"
              type="text"
              placeholder="G…"
              [(ngModel)]="slashAddress"
              [disabled]="isSlashing()"
              aria-label="Verifier address to slash"
            />
          </div>
          <div class="form-field form-field--grow">
            <label class="field-label" for="slash-credit-id">Credit ID (hex)</label>
            <input
              id="slash-credit-id"
              class="text-input"
              type="text"
              placeholder="64-character hex credit ID"
              [(ngModel)]="slashCreditId"
              [disabled]="isSlashing()"
              aria-label="Credit ID that triggered the slash"
            />
          </div>
          <button
            class="btn btn-danger btn-self-end"
            (click)="openSlashConfirm()"
            [disabled]="isSlashing() || !slashAddress.trim() || !slashCreditId.trim()"
          >
            {{ isSlashing() ? 'Slashing…' : 'Slash 10%' }}
          </button>
        </div>
      </section>

      <!-- ── Contract Pause / Unpause ──────────────────────────────────────── -->
      <section class="panel-section panel-section--danger">
        <h2 class="section-title section-title--danger">Contract Pause</h2>
        <p class="section-description">
          Pause or resume all contract operations. When paused, no credits can be issued, retired,
          or traded.
        </p>

        @if (pauseError()) {
          <p class="alert alert--error" role="alert">{{ pauseError() }}</p>
        }

        <button class="btn btn-danger" (click)="openPauseConfirm()" [disabled]="isPausing()">
          {{ contractPaused() ? 'Unpause Contract' : 'Pause Contract' }}
        </button>
      </section>
    </main>

    <!-- ── Pause confirmation modal ─────────────────────────────────────── -->
    @if (showPauseConfirm()) {
      <div class="modal-backdrop" (click)="closePauseConfirm()">
        <div
          class="modal modal--danger"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pause-title"
          (click)="$event.stopPropagation()"
        >
          <h2 id="pause-title">
            {{ contractPaused() ? 'Unpause Contract?' : 'Pause Contract?' }}
          </h2>
          <p class="pause-warning">
            I understand that
            {{ contractPaused() ? 'resuming' : 'pausing' }} the contract
            <strong>{{ contractPaused() ? 'will restore' : 'will stop' }}</strong>
            all operations — credit issuance, retirement, and trading will be
            {{ contractPaused() ? 'enabled' : 'disabled' }} immediately.
          </p>
          <div class="modal-actions">
            <button class="btn btn-ghost" (click)="closePauseConfirm()" [disabled]="isPausing()">
              Cancel
            </button>
            <button class="btn btn-danger" (click)="confirmPause()" [disabled]="isPausing()">
              {{ isPausing() ? 'Processing…' : 'I understand, proceed' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- ── Slash confirmation modal ──────────────────────────────────────── -->
    @if (showSlashConfirm()) {
      <div class="modal-backdrop" (click)="closeSlashConfirm()">
        <div
          class="modal modal--danger"
          role="dialog"
          aria-modal="true"
          aria-labelledby="slash-title"
          (click)="$event.stopPropagation()"
        >
          <h2 id="slash-title">Slash Verifier Stake?</h2>
          <p class="pause-warning">
            This will permanently slash <strong>10%</strong> of verifier
            <span class="monospace">{{ slashAddress | slice: 0 : 8 }}…</span>'s locked stake as a
            penalty for approving fraudulent credit
            <span class="monospace">{{ slashCreditId | slice: 0 : 12 }}…</span>. The slashed funds
            are forfeited and cannot be recovered.
          </p>
          <div class="modal-actions">
            <button class="btn btn-ghost" (click)="closeSlashConfirm()" [disabled]="isSlashing()">
              Cancel
            </button>
            <button class="btn btn-danger" (click)="confirmSlash()" [disabled]="isSlashing()">
              {{ isSlashing() ? 'Slashing…' : 'I understand, slash 10%' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .admin-panel {
        padding: 2rem;
      }
      .stake-info {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 1rem;
        font-size: 0.95rem;
      }
      .stake-sub {
        color: #888;
        font-size: 0.8rem;
      }
      .stake-result {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.75rem;
        padding: 0.5rem 0.75rem;
        background: #f5f5f5;
        border-radius: 6px;
        font-size: 0.9rem;
      }
      .badge--warn {
        background: #fff3cd;
        color: #856404;
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
        font-size: 0.8rem;
      }
      .badge--ok {
        background: #d1e7dd;
        color: #0f5132;
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
        font-size: 0.8rem;
      }
      .subsection-title {
        font-size: 1rem;
        font-weight: 600;
        margin-top: 1.5rem;
        margin-bottom: 0.25rem;
        color: #333;
      }
      .section-description--sm {
        font-size: 0.85rem;
      }
      .status-loading {
        color: #888;
        font-style: italic;
      }
      .monospace {
        font-family: monospace;
        font-size: 0.85em;
      }
    `,
  ],
})
export class AdminComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly wallet = inject(StellarWalletService);
  private readonly toast = inject(ToastService);

  // Expose BigInt to template (used in stake comparison)
  protected readonly BigInt = BigInt;

  // ── Methodology registration state ──────────────────────────────────────
  protected methodologyName = '';
  protected methodologyDescription = '';
  protected readonly isRegisteringMethodology = signal(false);
  protected readonly methodologyError = signal<string | null>(null);
  protected readonly registeredMethodologies = signal<{ name: string; description: string }[]>([]);

  // ── Required approvals state ─────────────────────────────────────────────
  protected readonly requiredApprovals = signal(1);
  protected readonly maxApprovals = signal(10);
  protected readonly isSavingApprovals = signal(false);
  protected readonly approvalsError = signal<string | null>(null);

  // ── Staking state ────────────────────────────────────────────────────────
  /** Current on-chain minimum stake (stroops as string). */
  protected readonly minStake = signal('0');
  protected readonly minStakeLoading = signal(true);
  /** New minimum stake the admin wants to set, expressed in XLM (not stroops). */
  protected newMinStakeXlm: number | null = null;
  protected readonly isSavingMinStake = signal(false);
  protected readonly stakeError = signal<string | null>(null);

  /** Address to check current stake balance for. */
  protected stakeCheckAddress = '';
  protected readonly isCheckingStake = signal(false);
  protected readonly verifierStakeResult = signal<{ address: string; stake: string } | null>(null);

  /** Fields for slash confirmation. */
  protected slashAddress = '';
  protected slashCreditId = '';
  protected readonly isSlashing = signal(false);
  protected readonly slashError = signal<string | null>(null);
  protected readonly showSlashConfirm = signal(false);

  // ── Pause state ──────────────────────────────────────────────────────────
  protected readonly contractPaused = signal(false);
  protected readonly showPauseConfirm = signal(false);
  protected readonly isPausing = signal(false);
  protected readonly pauseError = signal<string | null>(null);

  ngOnInit(): void {
    void this.loadStats();
    void this.loadMinStake();
  }

  private async loadStats(): Promise<void> {
    try {
      const token = this.auth.token()!;
      const stats = await firstValueFrom(this.api.getAdminStats(token));
      this.maxApprovals.set(Math.max(stats.activeVerifiers, 1));
      this.contractPaused.set(stats.paused);
    } catch {
      // Non-fatal — defaults suffice
    }
  }

  private async loadMinStake(): Promise<void> {
    this.minStakeLoading.set(true);
    try {
      const result = await firstValueFrom(this.api.getMinStake());
      this.minStake.set(result.minStake);
    } catch {
      // Non-fatal — show 0
    } finally {
      this.minStakeLoading.set(false);
    }
  }

  /** Format a stroops string as an XLM value (7 decimal places). */
  protected formatStroops(stroops: string): string {
    try {
      const xlm = Number(BigInt(stroops)) / 10_000_000;
      return xlm.toLocaleString(undefined, { maximumFractionDigits: 7 });
    } catch {
      return '0';
    }
  }

  // ── Methodology ───────────────────────────────────────────────────────────

  async submitMethodology(): Promise<void> {
    const name = this.methodologyName.trim();
    const description = this.methodologyDescription.trim();
    if (!name || !description) return;

    this.isRegisteringMethodology.set(true);
    this.methodologyError.set(null);
    try {
      const token = this.auth.token()!;
      await firstValueFrom(this.api.registerMethodology(name, description, token));
      this.registeredMethodologies.update((list) => [...list, { name, description }]);
      this.methodologyName = '';
      this.methodologyDescription = '';
      this.toast.show(`Methodology "${name}" registered.`, 'success');
    } catch (err) {
      this.methodologyError.set(
        err instanceof Error ? err.message : 'Failed to register methodology.',
      );
    } finally {
      this.isRegisteringMethodology.set(false);
    }
  }

  // ── Required approvals ───────────────────────────────────────────────────

  onSliderChange(event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    if (!isNaN(value)) {
      this.requiredApprovals.set(value);
    }
  }

  async saveRequiredApprovals(): Promise<void> {
    this.isSavingApprovals.set(true);
    this.approvalsError.set(null);
    try {
      const token = this.auth.token()!;
      await firstValueFrom(this.api.setRequiredApprovals(this.requiredApprovals(), token));
      this.toast.show(`Required approvals set to ${this.requiredApprovals()}.`, 'success');
    } catch (err) {
      this.approvalsError.set(
        err instanceof Error ? err.message : 'Failed to save approvals threshold.',
      );
    } finally {
      this.isSavingApprovals.set(false);
    }
  }

  // ── Staking ───────────────────────────────────────────────────────────────

  async saveMinStake(): Promise<void> {
    if (this.newMinStakeXlm === null) return;
    this.isSavingMinStake.set(true);
    this.stakeError.set(null);
    try {
      const token = this.auth.token()!;
      const address = this.wallet.publicKey();
      if (!address) throw new Error('Not authenticated');

      // Fetch the admin's current nonce before building the transaction.
      const nonceResp = await firstValueFrom(this.api.getAdminNonce(address, token));
      const amountStroops = Math.round(this.newMinStakeXlm * 10_000_000).toString();

      await firstValueFrom(this.api.setMinStake(amountStroops, nonceResp.nonce.toString(), token));
      this.minStake.set(amountStroops);
      this.newMinStakeXlm = null;
      this.toast.show(
        `Minimum stake updated to ${this.formatStroops(amountStroops)} XLM.`,
        'success',
      );
    } catch (err) {
      this.stakeError.set(err instanceof Error ? err.message : 'Failed to update minimum stake.');
    } finally {
      this.isSavingMinStake.set(false);
    }
  }

  async checkVerifierStake(): Promise<void> {
    const address = this.stakeCheckAddress.trim();
    if (!address) return;
    this.isCheckingStake.set(true);
    this.verifierStakeResult.set(null);
    try {
      const result = await firstValueFrom(this.api.getVerifierStake(address));
      this.verifierStakeResult.set(result);
    } catch (err) {
      this.stakeError.set(err instanceof Error ? err.message : 'Failed to fetch verifier stake.');
    } finally {
      this.isCheckingStake.set(false);
    }
  }

  openSlashConfirm(): void {
    this.slashError.set(null);
    this.showSlashConfirm.set(true);
  }

  closeSlashConfirm(): void {
    this.showSlashConfirm.set(false);
  }

  async confirmSlash(): Promise<void> {
    this.isSlashing.set(true);
    this.slashError.set(null);
    try {
      const token = this.auth.token()!;
      const address = this.wallet.publicKey();
      if (!address) throw new Error('Not authenticated');

      // Fetch the admin's current nonce before the slash transaction.
      const nonceResp = await firstValueFrom(this.api.getAdminNonce(address, token));
      await firstValueFrom(
        this.api.slashVerifier(
          this.slashAddress.trim(),
          this.slashCreditId.trim(),
          nonceResp.nonce.toString(),
          token,
        ),
      );
      this.toast.show(
        `Slashed 10% of verifier ${this.slashAddress.slice(0, 8)}…'s stake.`,
        'success',
      );
      this.slashAddress = '';
      this.slashCreditId = '';
      this.showSlashConfirm.set(false);
    } catch (err) {
      this.slashError.set(err instanceof Error ? err.message : 'Failed to slash verifier.');
    } finally {
      this.isSlashing.set(false);
    }
  }

  // ── Pause / Unpause ───────────────────────────────────────────────────────

  openPauseConfirm(): void {
    this.pauseError.set(null);
    this.showPauseConfirm.set(true);
  }

  closePauseConfirm(): void {
    this.showPauseConfirm.set(false);
  }

  async confirmPause(): Promise<void> {
    this.isPausing.set(true);
    this.pauseError.set(null);
    try {
      const token = this.auth.token()!;
      const currentlyPaused = this.contractPaused();
      const result = currentlyPaused
        ? await firstValueFrom(this.api.unpauseContract(token))
        : await firstValueFrom(this.api.pauseContract(token));
      this.contractPaused.set(result.paused);
      this.toast.show(
        result.paused
          ? 'Contract paused. All operations stopped.'
          : 'Contract unpaused. Operations resumed.',
        'success',
      );
      this.showPauseConfirm.set(false);
    } catch (err) {
      this.pauseError.set(err instanceof Error ? err.message : 'Failed to toggle contract pause.');
    } finally {
      this.isPausing.set(false);
    }
  }
}
