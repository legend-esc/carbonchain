import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, VerifierInfo } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { ToastService } from '../core/services/toast.service';

const METHODOLOGY_OPTIONS = ['Verra VCS', 'Gold Standard', 'CAR', 'ACR', 'Plan Vivo'];
const GEOGRAPHY_OPTIONS = ['Africa', 'Asia-Pacific', 'Europe', 'Latin America', 'North America'];

@Component({
  selector: 'app-admin-verifiers',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="admin-verifiers">
      <div class="toolbar">
        <div>
          <h1 class="page-title">Verifier Management</h1>
          @if (stats()) {
            <p class="stats-summary">
              Active verifiers: <strong>{{ stats()!.activeVerifiers }}</strong>
            </p>
          }
        </div>
        <button class="btn btn-primary" (click)="openRegister()">+ Register Verifier</button>
      </div>

      @if (error()) {
        <p class="alert alert--error" role="alert">{{ error() }}</p>
      } @else if (isLoading()) {
        <p class="status">Loading verifiers…</p>
      } @else if (verifiers().length === 0) {
        <p class="status">No verifiers registered.</p>
      } @else {
        <table class="verifiers-table" aria-label="Registered verifiers">
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (v of verifiers(); track v.address) {
              <tr class="verifier-row">
                <td class="mono" [title]="v.address">{{ v.address }}</td>
                <td class="actions-cell">
                  <button class="btn btn-sm btn-secondary" (click)="openConfigure(v.address)">
                    Configure
                  </button>
                  <button class="btn btn-sm btn-danger" (click)="openSuspend(v.address)">
                    Suspend
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>

    <!-- Register modal -->
    @if (showRegister()) {
      <div class="modal-backdrop" (click)="closeRegister()">
        <div
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="register-title"
          (click)="$event.stopPropagation()"
        >
          <h2 id="register-title">Register New Verifier</h2>
          <label class="field-label" for="register-address">Stellar Address</label>
          <input
            id="register-address"
            class="text-input"
            type="text"
            placeholder="G…"
            [(ngModel)]="registerAddressValue"
          />
          <div class="modal-actions">
            <button class="btn btn-ghost" (click)="closeRegister()" [disabled]="isRegistering()">
              Cancel
            </button>
            <button
              class="btn btn-primary"
              (click)="submitRegister()"
              [disabled]="isRegistering() || !registerAddressValue.trim()"
            >
              {{ isRegistering() ? 'Registering…' : 'Register' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Configure capabilities modal -->
    @if (configuringVerifier()) {
      <div class="modal-backdrop" (click)="closeConfigure()">
        <div
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="configure-title"
          (click)="$event.stopPropagation()"
        >
          <h2 id="configure-title">Configure Capabilities</h2>
          <p class="modal-subtitle mono">{{ configuringVerifier() }}</p>

          <fieldset class="capability-group">
            <legend>Methodologies</legend>
            @for (m of methodologyOptions; track m) {
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  [checked]="selectedMethodologies().includes(m)"
                  (change)="toggleMethodology(m)"
                />
                {{ m }}
              </label>
            }
          </fieldset>

          <fieldset class="capability-group">
            <legend>Geographies</legend>
            @for (g of geographyOptions; track g) {
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  [checked]="selectedGeographies().includes(g)"
                  (change)="toggleGeography(g)"
                />
                {{ g }}
              </label>
            }
          </fieldset>

          <div class="modal-actions">
            <button class="btn btn-ghost" (click)="closeConfigure()" [disabled]="isConfiguring()">
              Cancel
            </button>
            <button
              class="btn btn-primary"
              (click)="submitConfigure()"
              [disabled]="isConfiguring()"
            >
              {{ isConfiguring() ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Suspend confirmation modal -->
    @if (suspendingVerifier()) {
      <div class="modal-backdrop" (click)="closeSuspend()">
        <div
          class="modal modal--danger"
          role="dialog"
          aria-modal="true"
          aria-labelledby="suspend-title"
          (click)="$event.stopPropagation()"
        >
          <h2 id="suspend-title">Suspend Verifier?</h2>
          <p>This will suspend verifier:</p>
          <p class="mono suspend-address">{{ suspendingVerifier() }}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" (click)="closeSuspend()" [disabled]="isSuspending()">
              Cancel
            </button>
            <button class="btn btn-danger" (click)="confirmSuspend()" [disabled]="isSuspending()">
              {{ isSuspending() ? 'Suspending…' : 'Confirm Suspend' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .admin-verifiers {
        max-width: 900px;
        margin: 2rem auto;
        padding: 0 1rem;
      }

      .toolbar {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 1.5rem;
      }
      .page-title {
        margin: 0 0 0.25rem;
        font-size: 1.5rem;
      }
      .stats-summary {
        margin: 0;
        font-size: 0.9rem;
        color: #666;
      }

      .status {
        color: #888;
      }
      .alert--error {
        color: #c62828;
        background: #ffebee;
        padding: 0.75rem 1rem;
        border-radius: 6px;
      }

      .verifiers-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
      }
      .verifiers-table th,
      .verifiers-table td {
        padding: 0.65rem 1rem;
        border-bottom: 1px solid #e0e0e0;
        text-align: left;
      }
      .verifiers-table th {
        background: #f5f5f5;
        font-weight: 600;
      }
      .verifier-row:hover {
        background: #fafafa;
      }
      .actions-cell {
        display: flex;
        gap: 0.5rem;
      }
      .mono {
        font-family: monospace;
        font-size: 0.85rem;
        word-break: break-all;
      }

      .btn {
        padding: 0.45rem 1.1rem;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        font-size: 0.85rem;
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
      .btn-secondary {
        background: #1565c0;
        color: #fff;
      }
      .btn-danger {
        background: #d32f2f;
        color: #fff;
      }
      .btn-ghost {
        background: transparent;
        border: 1px solid #bbb;
        color: #444;
      }
      .btn-sm {
        padding: 0.3rem 0.7rem;
        font-size: 0.8rem;
      }

      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
      }
      .modal {
        background: #fff;
        border-radius: 10px;
        padding: 1.75rem 2rem;
        min-width: 360px;
        max-width: 480px;
        width: 100%;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
      }
      .modal h2 {
        margin: 0 0 1rem;
        font-size: 1.2rem;
      }
      .modal-subtitle {
        margin: -0.5rem 0 1rem;
        color: #555;
        font-size: 0.82rem;
      }
      .modal--danger h2 {
        color: #c62828;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.75rem;
        margin-top: 1.5rem;
      }

      .field-label {
        display: block;
        font-size: 0.85rem;
        font-weight: 600;
        margin-bottom: 0.35rem;
      }
      .text-input {
        width: 100%;
        box-sizing: border-box;
        padding: 0.5rem 0.75rem;
        border: 1px solid #bbb;
        border-radius: 6px;
        font-size: 0.9rem;
        font-family: monospace;
      }
      .text-input:focus {
        outline: 2px solid #4caf50;
        border-color: transparent;
      }

      .capability-group {
        border: 1px solid #ddd;
        border-radius: 6px;
        padding: 0.75rem 1rem;
        margin-bottom: 1rem;
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
        font-size: 0.88rem;
        margin: 0.3rem 0;
        cursor: pointer;
      }

      .suspend-address {
        background: #ffebee;
        padding: 0.5rem 0.75rem;
        border-radius: 4px;
        margin: 0.25rem 0 0;
      }
    `,
  ],
})
export class AdminVerifiersComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly verifiers = signal<VerifierInfo[]>([]);
  protected readonly isLoading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly stats = signal<{
    totalCredits: number;
    totalRetirements: number;
    activeVerifiers: number;
  } | null>(null);

  // Register modal state
  protected readonly showRegister = signal(false);
  protected readonly isRegistering = signal(false);
  protected registerAddressValue = '';

  // Configure modal state
  protected readonly configuringVerifier = signal<string | null>(null);
  protected readonly selectedMethodologies = signal<string[]>([]);
  protected readonly selectedGeographies = signal<string[]>([]);
  protected readonly isConfiguring = signal(false);

  // Suspend confirmation state
  protected readonly suspendingVerifier = signal<string | null>(null);
  protected readonly isSuspending = signal(false);

  readonly methodologyOptions = METHODOLOGY_OPTIONS;
  readonly geographyOptions = GEOGRAPHY_OPTIONS;

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);
    try {
      const token = this.auth.token()!;
      const [list, adminStats] = await Promise.all([
        firstValueFrom(this.api.listVerifiers()),
        firstValueFrom(this.api.getAdminStats(token)),
      ]);
      this.verifiers.set(list);
      this.stats.set(adminStats);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load verifiers.');
    } finally {
      this.isLoading.set(false);
    }
  }

  openRegister(): void {
    this.registerAddressValue = '';
    this.showRegister.set(true);
  }

  closeRegister(): void {
    this.showRegister.set(false);
  }

  async submitRegister(): Promise<void> {
    const address = this.registerAddressValue.trim();
    if (!address) return;
    this.isRegistering.set(true);
    try {
      await firstValueFrom(this.api.registerVerifier(address, this.auth.token()!));
      this.toast.show('Verifier registered successfully.', 'success');
      this.showRegister.set(false);
      await this.load();
    } catch (err) {
      this.toast.show(err instanceof Error ? err.message : 'Registration failed.', 'error');
    } finally {
      this.isRegistering.set(false);
    }
  }

  openConfigure(address: string): void {
    this.configuringVerifier.set(address);
    this.selectedMethodologies.set([]);
    this.selectedGeographies.set([]);
  }

  closeConfigure(): void {
    this.configuringVerifier.set(null);
  }

  toggleMethodology(m: string): void {
    const current = this.selectedMethodologies();
    this.selectedMethodologies.set(
      current.includes(m) ? current.filter((x) => x !== m) : [...current, m],
    );
  }

  toggleGeography(g: string): void {
    const current = this.selectedGeographies();
    this.selectedGeographies.set(
      current.includes(g) ? current.filter((x) => x !== g) : [...current, g],
    );
  }

  async submitConfigure(): Promise<void> {
    const id = this.configuringVerifier();
    if (!id) return;
    this.isConfiguring.set(true);
    try {
      await firstValueFrom(
        this.api.configureVerifier(
          id,
          { methodologies: this.selectedMethodologies(), geographies: this.selectedGeographies() },
          this.auth.token()!,
        ),
      );
      this.toast.show('Capabilities saved.', 'success');
      this.configuringVerifier.set(null);
    } catch (err) {
      this.toast.show(err instanceof Error ? err.message : 'Configuration failed.', 'error');
    } finally {
      this.isConfiguring.set(false);
    }
  }

  openSuspend(address: string): void {
    this.suspendingVerifier.set(address);
  }

  closeSuspend(): void {
    this.suspendingVerifier.set(null);
  }

  async confirmSuspend(): Promise<void> {
    const id = this.suspendingVerifier();
    if (!id) return;
    this.isSuspending.set(true);
    try {
      await firstValueFrom(this.api.suspendVerifier(id, this.auth.token()!));
      this.toast.show('Verifier suspended.', 'success');
      this.suspendingVerifier.set(null);
      await this.load();
    } catch (err) {
      this.toast.show(err instanceof Error ? err.message : 'Suspend failed.', 'error');
    } finally {
      this.isSuspending.set(false);
    }
  }
}
