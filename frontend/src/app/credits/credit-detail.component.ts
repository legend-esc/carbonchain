import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CreditMetadata, CreditStatus } from '@shared';
import { ApiService, ProvenanceEvent } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ProvenanceTimelineComponent } from './provenance-timeline.component';

@Component({
  selector: 'app-credit-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, ProvenanceTimelineComponent],
  template: `
    <div class="credit-detail">
      @if (loading()) {
        <p class="status">Loading credit…</p>
      } @else if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (credit()) {
        <div class="header">
          <h1>
            Credit <span class="mono">{{ credit()!.id | slice: 0 : 16 }}…</span>
          </h1>
          <span class="badge" [class]="'badge-' + credit()!.status.toLowerCase()">{{
            credit()!.status
          }}</span>
        </div>

        <section class="card">
          <h2>Metadata</h2>
          <dl>
            <dt>Project</dt>
            <dd>{{ credit()!.project_id }}</dd>
            <dt>Issuer</dt>
            <dd class="mono">{{ credit()!.issuer }}</dd>
            <dt>Vintage Year</dt>
            <dd>{{ credit()!.vintage_year }}</dd>
            <dt>Methodology</dt>
            <dd>{{ credit()!.methodology }}</dd>
            <dt>Geography</dt>
            <dd>{{ credit()!.geography }}</dd>
            <dt>Tonnes</dt>
            <dd>{{ formatTonnes(credit()!.tonnes) }}</dd>
            <dt>Issued At</dt>
            <dd>{{ credit()!.issued_at | date: 'medium' }}</dd>
            <dt>IPFS</dt>
            <dd>
              <a
                [href]="'https://ipfs.io/ipfs/' + credit()!.ipfs_hash"
                target="_blank"
                rel="noopener"
              >
                {{ credit()!.ipfs_hash | slice: 0 : 20 }}…
              </a>
            </dd>
          </dl>
        </section>

        <section class="card">
          <h2>Provenance Chain</h2>
          @if (provenanceLoading()) {
            <p class="status">Loading provenance…</p>
          } @else if (provenanceError()) {
            <p class="error">{{ provenanceError() }}</p>
          } @else if (provenance().length > 0) {
            <app-provenance-timeline [events]="provenance()" />
          } @else {
            <p class="status">No provenance data available.</p>
          }
        </section>

        <section class="card">
          <h2>MRV History</h2>
          @if (mrvHistory().length === 0) {
            <p class="status">No MRV data points recorded.</p>
          } @else {
            <table class="mrv-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Tonnes Sequestered</th>
                  <th>Oracle</th>
                  <th>Anomaly</th>
                </tr>
              </thead>
              <tbody>
                @for (point of mrvHistory(); track point.measurement_date) {
                  <tr>
                    <td>{{ point.measurement_date | date: 'mediumDate' }}</td>
                    <td>{{ formatTonnes(point.tonnes_sequestered) }}</td>
                    <td class="mono">{{ point.oracle | slice: 0 : 12 }}…</td>
                    <td>{{ point.anomaly_flag ? '⚠️' : '✓' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>

        @if (isOwner()) {
          <!-- Primary Actions -->
          <div class="actions">
            <button
              class="btn btn-danger"
              (click)="retire()"
              [disabled]="credit()!.status !== 'Active'"
            >
              Retire Credit
            </button>
            <button
              class="btn btn-primary"
              (click)="sell()"
              [disabled]="credit()!.status !== 'Active'"
            >
              Sell Credit
            </button>
            <button
              class="btn btn-secondary"
              (click)="toggleSplitPanel()"
              [disabled]="credit()!.status !== 'Active'"
              [attr.aria-expanded]="showSplitPanel()"
            >
              {{ showSplitPanel() ? 'Cancel Split' : 'Split Credit' }}
            </button>
            <button
              class="btn btn-secondary"
              (click)="toggleMergePanel()"
              [disabled]="credit()!.status !== 'Active'"
              [attr.aria-expanded]="showMergePanel()"
            >
              {{ showMergePanel() ? 'Cancel Merge' : 'Merge Credits' }}
            </button>
          </div>

          <!-- Split Panel -->
          @if (showSplitPanel()) {
            <section class="card action-card" aria-label="Split credit form">
              <h2>Split Credit</h2>
              <p class="help-text">
                Divide this credit into two child credits. The first child receives the tonnes you
                specify; the remainder goes to the second child.
                Total available: <strong>{{ formatTonnes(credit()!.tonnes) }}</strong>
              </p>

              @if (splitError()) {
                <p class="alert alert--error" role="alert">{{ splitError() }}</p>
              }
              @if (splitResult()) {
                <div class="alert alert--success" role="status">
                  <strong>Split successful!</strong><br />
                  Child 1: <span class="mono">{{ splitResult()!.childCredit1 }}</span><br />
                  Child 2: <span class="mono">{{ splitResult()!.childCredit2 }}</span>
                </div>
              }

              @if (!splitResult()) {
                <form class="action-form" (ngSubmit)="submitSplit()" #splitForm="ngForm">
                  <div class="field-group">
                    <label class="field-label" for="split-tonnes">
                      Tonnes for first child (t CO₂e)
                    </label>
                    <input
                      id="split-tonnes"
                      class="text-input"
                      type="number"
                      step="0.1"
                      min="0.1"
                      [max]="maxSplitTonnes()"
                      placeholder="e.g. 0.5"
                      [(ngModel)]="splitTonnesInput"
                      name="splitTonnes"
                      required
                      #splitTonnesField="ngModel"
                    />
                    @if (splitTonnesField.invalid && splitTonnesField.touched) {
                      <span class="field-error">
                        Enter a value between 0.1 and {{ maxSplitTonnes() }} t.
                      </span>
                    }
                  </div>

                  <div class="field-group">
                    <label class="field-label" for="split-destination">
                      Destination address for first child
                    </label>
                    <input
                      id="split-destination"
                      class="text-input"
                      type="text"
                      placeholder="G… (leave blank to keep in your wallet)"
                      [(ngModel)]="splitDestinationInput"
                      name="splitDestination"
                    />
                  </div>

                  <div class="form-actions">
                    <button
                      type="submit"
                      class="btn btn-primary"
                      [disabled]="splitLoading() || splitForm.invalid || !isSplitValid()"
                    >
                      {{ splitLoading() ? 'Splitting…' : 'Confirm Split' }}
                    </button>
                    <button type="button" class="btn btn-ghost" (click)="toggleSplitPanel()">
                      Cancel
                    </button>
                  </div>
                </form>
              }
            </section>
          }

          <!-- Merge Panel -->
          @if (showMergePanel()) {
            <section class="card action-card" aria-label="Merge credits form">
              <h2>Merge Credits</h2>
              <p class="help-text">
                Select credits with the same methodology (<strong>{{ credit()!.methodology }}</strong>),
                vintage year (<strong>{{ credit()!.vintage_year }}</strong>), and issuer to merge
                into this credit.
              </p>

              @if (mergeError()) {
                <p class="alert alert--error" role="alert">{{ mergeError() }}</p>
              }
              @if (mergeResult()) {
                <div class="alert alert--success" role="status">
                  <strong>Merge successful!</strong><br />
                  Merged credit ID: <span class="mono">{{ mergeResult()!.mergedCreditId }}</span>
                </div>
              }

              @if (!mergeResult()) {
                @if (eligibleCredits().length === 0) {
                  <p class="status">
                    No eligible credits found with the same methodology, vintage year, and issuer.
                  </p>
                } @else {
                  <form class="action-form" (ngSubmit)="submitMerge()">
                    <fieldset class="merge-fieldset">
                      <legend class="field-label">Select credits to merge with this one</legend>
                      @for (c of eligibleCredits(); track c.id) {
                        <label class="merge-option">
                          <input
                            type="checkbox"
                            [value]="c.id"
                            [checked]="isMergeSelected(c.id)"
                            (change)="toggleMergeSelection(c.id)"
                          />
                          <span class="mono">{{ c.id | slice: 0 : 16 }}…</span>
                          &nbsp;–&nbsp;{{ formatTonnes(c.tonnes) }}
                        </label>
                      }
                    </fieldset>

                    <div class="form-actions">
                      <button
                        type="submit"
                        class="btn btn-primary"
                        [disabled]="mergeLoading() || mergeSelectedIds().length === 0"
                      >
                        {{ mergeLoading() ? 'Merging…' : 'Confirm Merge (' + mergeSelectedIds().length + ' credits)' }}
                      </button>
                      <button type="button" class="btn btn-ghost" (click)="toggleMergePanel()">
                        Cancel
                      </button>
                    </div>
                  </form>
                }
              }
            </section>
          }
        }
      }
    </div>
  `,
  styles: [
    `
      .credit-detail {
        max-width: 800px;
        margin: 0 auto;
      }
      .header {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin-bottom: 1.5rem;
      }
      h1 {
        margin: 0;
      }
      .card {
        background: #f9f9f9;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        padding: 1.25rem;
        margin-bottom: 1.25rem;
      }
      .action-card {
        background: #fff;
        border-color: #1976d2;
      }
      h2 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
        color: #444;
      }
      dl {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 0.4rem 1rem;
        font-size: 0.9rem;
      }
      dt {
        font-weight: 600;
        color: #666;
      }
      .mono {
        font-family: monospace;
        word-break: break-all;
      }
      .mrv-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .mrv-table th,
      .mrv-table td {
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid #eee;
        text-align: left;
      }
      .mrv-table th {
        background: #f0f0f0;
        font-weight: 600;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-top: 1rem;
        margin-bottom: 1rem;
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
      .btn-primary {
        background: #1976d2;
        color: #fff;
      }
      .btn-secondary {
        background: #e3f2fd;
        color: #1565c0;
        border: 1px solid #90caf9;
      }
      .btn-danger {
        background: #e53935;
        color: #fff;
      }
      .btn-ghost {
        background: transparent;
        color: #666;
        border: 1px solid #ccc;
      }
      .badge {
        padding: 0.2rem 0.6rem;
        border-radius: 4px;
        font-size: 0.75rem;
        text-transform: uppercase;
        font-weight: 600;
      }
      .badge-active {
        background: #e8f5e9;
        color: #2e7d32;
      }
      .badge-retired {
        background: #ede7f6;
        color: #512da8;
      }
      .badge-pending {
        background: #fff8e1;
        color: #f57f17;
      }
      .badge-flagged {
        background: #ffebee;
        color: #c62828;
      }
      .status {
        color: #888;
      }
      .error {
        color: #e53935;
      }
      .help-text {
        font-size: 0.875rem;
        color: #555;
        margin-bottom: 1rem;
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
      }
      .text-input:focus {
        outline: 2px solid #1976d2;
        border-color: transparent;
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
        color: #1b5e20;
        border: 1px solid #a5d6a7;
        line-height: 1.8;
      }
      .merge-fieldset {
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        padding: 0.75rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .merge-fieldset legend {
        padding: 0 0.25rem;
      }
      .merge-option {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.875rem;
        cursor: pointer;
      }
      .merge-option input[type='checkbox'] {
        cursor: pointer;
      }
    `,
  ],
})
export class CreditDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  private readonly store = inject(CreditStore);

  // ── Core credit signals ────────────────────────────────────────────────────

  readonly credit = signal<CreditMetadata | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly mrvHistory = signal<import('@shared').MrvDataPoint[]>([]);
  readonly provenance = signal<ProvenanceEvent[]>([]);
  readonly provenanceLoading = signal(false);
  readonly provenanceError = signal<string | null>(null);

  readonly isOwner = () => {
    const c = this.credit();
    const pk = this.wallet.publicKey();
    return !!c && !!pk && c.owner === pk;
  };

  // ── Split state ────────────────────────────────────────────────────────────

  readonly showSplitPanel = signal(false);
  readonly splitLoading = signal(false);
  readonly splitError = signal<string | null>(null);
  readonly splitResult = signal<{ childCredit1: string; childCredit2: string } | null>(null);

  splitTonnesInput: number | null = null;
  splitDestinationInput = '';

  /** Maximum tonnes that can be split off (exclusive upper bound). */
  readonly maxSplitTonnes = computed(() => {
    const c = this.credit();
    if (!c) return 0;
    return Number(BigInt(c.tonnes) / 1_000_000n) - 0.1;
  });

  isSplitValid(): boolean {
    const max = this.maxSplitTonnes();
    const val = this.splitTonnesInput;
    if (val === null || val === undefined) return false;
    return val > 0 && val < max + 0.1; // allow up to maxSplitTonnes
  }

  // ── Merge state ────────────────────────────────────────────────────────────

  readonly showMergePanel = signal(false);
  readonly mergeLoading = signal(false);
  readonly mergeError = signal<string | null>(null);
  readonly mergeResult = signal<{ mergedCreditId: string } | null>(null);
  readonly mergeSelectedIds = signal<string[]>([]);

  /** Credits eligible for merge: same methodology, vintage year, issuer; not this credit. */
  readonly eligibleCredits = computed(() => {
    const c = this.credit();
    if (!c) return [];
    return this.store
      .credits()
      .filter(
        (other) =>
          other.id !== c.id &&
          other.status === CreditStatus.Active &&
          other.methodology === c.methodology &&
          other.vintage_year === c.vintage_year &&
          other.issuer === c.issuer,
      );
  });

  isMergeSelected(id: string): boolean {
    return this.mergeSelectedIds().includes(id);
  }

  toggleMergeSelection(id: string): void {
    this.mergeSelectedIds.update((ids) =>
      ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id],
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id')!;
    try {
      const credit = await firstValueFrom(this.api.getCredit(id));
      this.credit.set(credit);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load credit.');
    } finally {
      this.loading.set(false);
    }
    this.loadProvenance(id);
    // Load store so eligible merge candidates are available.
    const c = this.credit();
    if (c?.project_id) {
      this.store.loadByProject(c.project_id).catch(() => {/* non-critical */});
    }
  }

  private async loadProvenance(id: string): Promise<void> {
    this.provenanceLoading.set(true);
    this.provenanceError.set(null);
    try {
      const events = await firstValueFrom(this.api.getCreditProvenance(id));
      this.provenance.set(events);
    } catch (err) {
      this.provenanceError.set(err instanceof Error ? err.message : 'Failed to load provenance.');
    } finally {
      this.provenanceLoading.set(false);
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  retire(): void {
    this.router.navigate(['/retire'], { queryParams: { creditId: this.credit()!.id } });
  }

  sell(): void {
    this.router.navigate(['/marketplace'], { queryParams: { sell: this.credit()!.id } });
  }

  toggleSplitPanel(): void {
    this.showSplitPanel.update((v) => !v);
    this.splitError.set(null);
    this.splitResult.set(null);
    this.splitTonnesInput = null;
    this.splitDestinationInput = '';
  }

  toggleMergePanel(): void {
    this.showMergePanel.update((v) => !v);
    this.mergeError.set(null);
    this.mergeResult.set(null);
    this.mergeSelectedIds.set([]);
  }

  /**
   * Build → sign → submit split flow.
   * Validates input, then calls the split service method.
   */
  async submitSplit(): Promise<void> {
    const c = this.credit();
    if (!c) return;
    const token = this.auth.token();
    if (!token) {
      this.splitError.set('You must be logged in to perform this action.');
      return;
    }

    const inputTonnes = this.splitTonnesInput;
    if (inputTonnes === null || inputTonnes === undefined || inputTonnes <= 0) {
      this.splitError.set('Split amount must be greater than 0.');
      return;
    }

    const totalBig = BigInt(c.tonnes);
    const splitBig = BigInt(Math.round(inputTonnes * 1_000_000));
    if (splitBig <= 0n) {
      this.splitError.set('Split amount must be greater than 0.');
      return;
    }
    if (splitBig >= totalBig) {
      this.splitError.set(
        `Split amount must be less than total credit tonnes (${this.formatTonnes(c.tonnes)}).`,
      );
      return;
    }

    this.splitLoading.set(true);
    this.splitError.set(null);

    try {
      // Build → sign → submit (service call stubs the actual contract invocation)
      const result = await this.store.splitCredit(c.id, splitBig.toString(), token);
      this.splitResult.set(result);
      // Refresh this credit from the store (it will no longer exist — show child info)
    } catch (err) {
      this.splitError.set(mapContractError(err));
    } finally {
      this.splitLoading.set(false);
    }
  }

  /**
   * Build → sign → submit merge flow.
   * Merges the currently selected credits with this credit.
   */
  async submitMerge(): Promise<void> {
    const c = this.credit();
    if (!c) return;
    const token = this.auth.token();
    if (!token) {
      this.mergeError.set('You must be logged in to perform this action.');
      return;
    }

    const selectedIds = this.mergeSelectedIds();
    if (selectedIds.length === 0) {
      this.mergeError.set('Select at least one credit to merge with.');
      return;
    }

    this.mergeLoading.set(true);
    this.mergeError.set(null);

    try {
      // Build → sign → submit (service call stubs the actual contract invocation)
      const result = await this.store.mergeCredits([c.id, ...selectedIds], token);
      this.mergeResult.set(result);
    } catch (err) {
      this.mergeError.set(mapContractError(err));
    } finally {
      this.mergeLoading.set(false);
    }
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  formatTonnes(raw: string): string {
    return (
      (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' t'
    );
  }
}
