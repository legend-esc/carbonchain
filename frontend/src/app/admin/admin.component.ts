import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { AdminVerifiersComponent } from './admin-verifiers.component';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { ToastService } from '../core/services/toast.service';

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
          Register a new carbon credit methodology. Credits submitted with this
          methodology name will pass validation on the contract.
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
          Set the minimum number of verifier approvals needed to mint a credit.
          Valid range: 1 –
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

      <!-- ── Contract Pause / Unpause ──────────────────────────────────────── -->
      <section class="panel-section panel-section--danger">
        <h2 class="section-title section-title--danger">Contract Pause</h2>
        <p class="section-description">
          Pause or resume all contract operations. When paused, no credits can be
          issued, retired, or traded.
        </p>

        @if (pauseError()) {
          <p class="alert alert--error" role="alert">{{ pauseError() }}</p>
        }

        <button
          class="btn btn-danger"
          (click)="openPauseConfirm()"
          [disabled]="isPausing()"
        >
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
            <button
              class="btn btn-ghost"
              (click)="closePauseConfirm()"
              [disabled]="isPausing()"
            >
              Cancel
            </button>
            <button
              class="btn btn-danger"
              (click)="confirmPause()"
              [disabled]="isPausing()"
            >
              {{ isPausing() ? 'Processing…' : 'I understand, proceed' }}
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
    `,
  ],
})
export class AdminComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  // ── Methodology registration state ──────────────────────────────────────
  protected methodologyName = '';
  protected methodologyDescription = '';
  protected readonly isRegisteringMethodology = signal(false);
  protected readonly methodologyError = signal<string | null>(null);
  protected readonly registeredMethodologies = signal<
    { name: string; description: string }[]
  >([]);

  // ── Required approvals state ─────────────────────────────────────────────
  protected readonly requiredApprovals = signal(1);
  protected readonly maxApprovals = signal(10);
  protected readonly isSavingApprovals = signal(false);
  protected readonly approvalsError = signal<string | null>(null);

  // ── Pause state ──────────────────────────────────────────────────────────
  protected readonly contractPaused = signal(false);
  protected readonly showPauseConfirm = signal(false);
  protected readonly isPausing = signal(false);
  protected readonly pauseError = signal<string | null>(null);

  ngOnInit(): void {
    // Seed the slider maximum from the active verifier count via admin stats.
    void this.loadStats();
  }

  private async loadStats(): Promise<void> {
    try {
      const token = this.auth.token()!;
      const stats = await firstValueFrom(this.api.getAdminStats(token));
      // Ensure at least 1 so the slider is always usable.
      this.maxApprovals.set(Math.max(stats.activeVerifiers, 1));
    } catch {
      // Non-fatal — slider defaults to max=10 if stats cannot be fetched.
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
      await firstValueFrom(
        this.api.setRequiredApprovals(this.requiredApprovals(), token),
      );
      this.toast.show(
        `Required approvals set to ${this.requiredApprovals()}.`,
        'success',
      );
    } catch (err) {
      this.approvalsError.set(
        err instanceof Error ? err.message : 'Failed to save approvals threshold.',
      );
    } finally {
      this.isSavingApprovals.set(false);
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
      // Toggle the pause state (actual contract call would go here).
      const newState = !this.contractPaused();
      this.contractPaused.set(newState);
      this.toast.show(
        newState ? 'Contract paused. All operations stopped.' : 'Contract unpaused. Operations resumed.',
        'success',
      );
      this.showPauseConfirm.set(false);
    } catch (err) {
      this.pauseError.set(
        err instanceof Error ? err.message : 'Failed to toggle contract pause.',
      );
    } finally {
      this.isPausing.set(false);
    }
  }
}
