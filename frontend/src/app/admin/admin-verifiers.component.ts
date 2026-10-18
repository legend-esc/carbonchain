import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, VerifierInfo } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { ToastService } from '../core/services/toast.service';

const METHODOLOGY_OPTIONS = ['Verra VCS', 'Gold Standard', 'CAR', 'ACR', 'Plan Vivo'];
const GEOGRAPHY_OPTIONS = ['Africa', 'Asia-Pacific', 'Europe', 'Latin America', 'North America'];

type SortKey = 'reputation' | 'stake' | 'address';
type SortDir = 'asc' | 'desc';

@Component({
  selector: 'app-admin-verifiers',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="admin-verifiers">
      <div class="toolbar">
        <div>
          <h1 class="page-title">Verifier Leaderboard</h1>
          @if (stats()) {
            <p class="stats-summary">
              Active verifiers: <strong>{{ stats()!.activeVerifiers }}</strong>
            </p>
          }
        </div>
        <button class="btn btn-primary" (click)="openRegister()">+ Register Verifier</button>
      </div>

      <div class="sort-bar">
        <label class="field-label" for="sort-key">Sort by</label>
        <select
          id="sort-key"
          class="text-input"
          [value]="sortKey()"
          (change)="onSortKeyChange($event)"
        >
          <option value="reputation">Reputation</option>
          <option value="stake">Stake (XLM)</option>
          <option value="address">Address</option>
        </select>
        <button class="btn btn-ghost btn-sm" (click)="toggleSortDir()">
          {{ sortDir() === 'asc' ? '↑ Asc' : '↓ Desc' }}
        </button>
      </div>

      @if (error()) {
        <p class="alert alert--error" role="alert">{{ error() }}</p>
      } @else if (isLoading()) {
        <p class="status">Loading verifiers…</p>
      } @else if (sortedVerifiers().length === 0) {
        <p class="status">No verifiers registered.</p>
      } @else {
        <table class="verifiers-table" aria-label="Verifier leaderboard">
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col" (click)="setSort('address')" class="sortable">
                Address {{ sortIcon('address') }}
              </th>
              <th scope="col" (click)="setSort('stake')" class="sortable">
                Stake (XLM) {{ sortIcon('stake') }}
              </th>
              <th scope="col" (click)="setSort('reputation')" class="sortable">
                Reputation {{ sortIcon('reputation') }}
              </th>
              <th scope="col">Approvals</th>
              <th scope="col">Disputes</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (v of sortedVerifiers(); track v.address; let i = $index) {
              <tr
                class="verifier-row"
                (click)="openDetail(v.address)"
                [class.verifier-row--selected]="selectedAddress() === v.address"
              >
                <td>{{ i + 1 }}</td>
                <td class="mono" [title]="v.address">{{ v.address }}</td>
                <td>{{ formatStake(v.address) }}</td>
                <td>{{ reputationScore(v) }}</td>
                <td>{{ v.reputation?.approvalCount ?? '—' }}</td>
                <td>{{ v.reputation?.disputeCount ?? '—' }}</td>
                <td class="actions-cell" (click)="$event.stopPropagation()">
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

      @if (selectedAddress()) {
        <div class="drawer-backdrop" (click)="closeDetail()">
          <div
            class="drawer"
            (click)="$event.stopPropagation()"
            role="dialog"
            aria-modal="true"
            [attr.aria-label]="'Verifier detail: ' + selectedAddress()"
          >
            <div class="drawer-header">
              <h2>Verifier Detail</h2>
              <button class="btn btn-ghost btn-sm" (click)="closeDetail()">Close</button>
            </div>

            @if (detailLoading()) {
              <p class="status">Loading details…</p>
            } @else if (detailError()) {
              <p class="alert alert--error" role="alert">{{ detailError() }}</p>
            } @else {
              <div class="drawer-section">
                <h3>Identity</h3>
                <p class="mono">{{ selectedAddress() }}</p>
              </div>

              <div class="drawer-section">
                <h3>Stake</h3>
                <p>
                  {{ detailStake() !== null ? (detailStake()! | number: '1.7-7') + ' XLM' : '—' }}
                </p>
              </div>

              <div class="drawer-section">
                <h3>Reputation</h3>
                <p>
                  Approvals:
                  <strong>{{ selectedVerifier()?.reputation?.approvalCount ?? '—' }}</strong>
                </p>
                <p>
                  Disputes:
                  <strong>{{ selectedVerifier()?.reputation?.disputeCount ?? '—' }}</strong>
                </p>
              </div>

              <div class="drawer-section">
                <h3>Methodologies & Geographies</h3>
                @if (selectedVerifier()?.capabilities?.length) {
                  <ul>
                    @for (c of selectedVerifier()!.capabilities!; track c) {
                      <li>{{ c }}</li>
                    }
                  </ul>
                } @else {
                  <p class="status">No capabilities configured.</p>
                }
              </div>

              <div class="drawer-section">
                <h3>Pending Credits</h3>
                @if (detailPendingLoading()) {
                  <p class="status">Loading…</p>
                } @else if (detailPending().length === 0) {
                  <p class="status">No pending credits.</p>
                } @else {
                  <ul class="history-list">
                    @for (c of detailPending(); track c.id) {
                      <li>
                        <span class="mono">{{ c.id | slice: 0 : 12 }}…</span>
                        <span>{{ c.tonnes | number: '1.2-2' }} t</span>
                        <span>{{ c.status }}</span>
                      </li>
                    }
                  </ul>
                }
              </div>

              <div class="drawer-section">
                <h3>Approval History</h3>
                @if (detailHistoryLoading()) {
                  <p class="status">Loading…</p>
                } @else if (detailHistory().length === 0) {
                  <p class="status">No approval history.</p>
                } @else {
                  <ul class="history-list">
                    @for (c of detailHistory(); track c.id) {
                      <li>
                        <span class="mono">{{ c.id | slice: 0 : 12 }}…</span>
                        <span>{{ c.tonnes | number: '1.2-2' }} t</span>
                        <span>{{ c.status }}</span>
                      </li>
                    }
                  </ul>
                }
              </div>
            }
          </div>
        </div>
      }

      @if (pendingApplications().length > 0) {
        <section class="pending-section">
          <h2 class="section-title">Pending Applications</h2>
          <table class="verifiers-table" aria-label="Pending verifier applications">
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">Name</th>
                <th scope="col">Documents CID</th>
                <th scope="col">Stake Amount</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (app of pendingApplications(); track app.address) {
                <tr>
                  <td class="mono">{{ app.address }}</td>
                  <td>{{ app.name || '—' }}</td>
                  <td class="mono">
                    {{ app.documentsCid | slice: 0 : 20
                    }}{{ app.documentsCid && app.documentsCid.length > 20 ? '…' : '' }}
                  </td>
                  <td>{{ app.stakeAmount }}</td>
                  <td class="actions-cell">
                    <button
                      class="btn btn-sm btn-primary"
                      (click)="approveApplication(app.address)"
                    >
                      Approve
                    </button>
                    <button class="btn btn-sm btn-danger" (click)="rejectApplication(app.address)">
                      Reject
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
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
        max-width: 1100px;
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

      .sort-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 1rem;
      }
      .sort-bar .text-input {
        width: auto;
        padding: 0.35rem 0.6rem;
        font-size: 0.85rem;
      }
      .sortable {
        cursor: pointer;
        user-select: none;
      }
      .sortable:hover {
        background: #eaeaea;
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
        cursor: pointer;
      }
      .verifier-row--selected {
        background: #e3f2fd;
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

      .drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 110;
      }
      .drawer {
        background: #fff;
        border-radius: 10px;
        padding: 1.75rem 2rem;
        min-width: 420px;
        max-width: 560px;
        width: 100%;
        max-height: 85vh;
        overflow-y: auto;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
      }
      .drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1.25rem;
      }
      .drawer-header h2 {
        margin: 0;
        font-size: 1.15rem;
      }
      .drawer-section {
        margin-bottom: 1.25rem;
      }
      .drawer-section h3 {
        margin: 0 0 0.4rem;
        font-size: 0.95rem;
        color: #444;
      }
      .drawer-section p {
        margin: 0.2rem 0;
        font-size: 0.9rem;
      }
      .history-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .history-list li {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        font-size: 0.85rem;
        padding: 0.35rem 0.5rem;
        background: #f5f5f5;
        border-radius: 4px;
      }

      .pending-section {
        margin-top: 2rem;
      }
      .section-title {
        margin: 0 0 0.75rem;
        font-size: 1.1rem;
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

  protected readonly sortKey = signal<SortKey>('reputation');
  protected readonly sortDir = signal<SortDir>('desc');
  protected readonly stakes = signal<Map<string, string>>(new Map());

  protected readonly selectedAddress = signal<string | null>(null);
  protected readonly detailLoading = signal(false);
  protected readonly detailError = signal<string | null>(null);
  protected readonly detailStake = signal<number | null>(null);
  protected readonly detailPending = signal<{ id: string; tonnes: string; status: string }[]>([]);
  protected readonly detailPendingLoading = signal(false);
  protected readonly detailHistory = signal<{ id: string; tonnes: string; status: string }[]>([]);
  protected readonly detailHistoryLoading = signal(false);

  protected readonly pendingApplications = signal<
    {
      address: string;
      name: string | null;
      documentsCid: string | null;
      stakeAmount: string | null;
      status: string;
    }[]
  >([]);

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
      const [list, adminStats, applications] = await Promise.all([
        firstValueFrom(this.api.listVerifiers()),
        firstValueFrom(this.api.getAdminStats(token)),
        firstValueFrom(this.api.listVerifierApplications(token, 'pending')),
      ]);
      this.verifiers.set(list);
      this.stats.set(adminStats);
      this.pendingApplications.set(
        applications.map((a) => ({
          address: a.address,
          name: a.name,
          documentsCid: a.documentsCid,
          stakeAmount: a.stakeAmount,
          status: a.status,
        })),
      );
      await this.loadStakes(list.map((v) => v.address));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load verifiers.');
    } finally {
      this.isLoading.set(false);
    }
  }

  private async loadStakes(addresses: string[]): Promise<void> {
    const results = await Promise.all(
      addresses.map((addr) =>
        firstValueFrom(this.api.getVerifierStake(addr))
          .then((r) => [addr, r.stake] as const)
          .catch(() => [addr, '0'] as const),
      ),
    );
    const map = new Map<string, string>();
    for (const [addr, stake] of results) {
      map.set(addr, stake);
    }
    this.stakes.set(map);
  }

  sortedVerifiers(): VerifierInfo[] {
    const key = this.sortKey();
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    const list = [...this.verifiers()];
    list.sort((a, b) => {
      let cmp = 0;
      if (key === 'address') {
        cmp = a.address.localeCompare(b.address);
      } else if (key === 'stake') {
        const sa = BigInt(this.stakes().get(a.address) ?? '0');
        const sb = BigInt(this.stakes().get(b.address) ?? '0');
        cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
      } else if (key === 'reputation') {
        const ea = this.reputationScore(a);
        const eb = this.reputationScore(b);
        cmp = ea < eb ? -1 : ea > eb ? 1 : 0;
      }
      return cmp * dir;
    });
    return list;
  }

  setSort(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortKey.set(key);
      this.sortDir.set('desc');
    }
  }

  onSortKeyChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as SortKey;
    this.setSort(value);
  }

  toggleSortDir(): void {
    this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
  }

  sortIcon(key: SortKey): string {
    if (this.sortKey() !== key) return '';
    return this.sortDir() === 'asc' ? '↑' : '↓';
  }

  formatStake(address: string): string {
    const raw = this.stakes().get(address) ?? '0';
    try {
      const xlm = Number(BigInt(raw)) / 10_000_000;
      return xlm.toLocaleString(undefined, { maximumFractionDigits: 7 });
    } catch {
      return '0';
    }
  }

  reputationScore(v: VerifierInfo): number {
    const approvals = v.reputation?.approvalCount ?? 0;
    const disputes = v.reputation?.disputeCount ?? 0;
    return approvals - disputes;
  }

  // ── Detail drawer ──────────────────────────────────────────────────────────

  selectedVerifier(): VerifierInfo | undefined {
    const addr = this.selectedAddress();
    if (!addr) return undefined;
    return this.verifiers().find((v) => v.address === addr);
  }

  async openDetail(address: string): Promise<void> {
    this.selectedAddress.set(address);
    this.detailLoading.set(true);
    this.detailError.set(null);
    this.detailPending.set([]);
    this.detailHistory.set([]);

    try {
      const [stakeResp, pending, history] = await Promise.all([
        firstValueFrom(this.api.getVerifierStake(address)).catch(() => ({ stake: '0' })),
        firstValueFrom(this.api.getVerifierPending(address)).catch(() => []),
        firstValueFrom(this.api.getVerifierHistory(address)).catch(() => []),
      ]);
      this.detailStake.set(Number(BigInt(stakeResp.stake)) / 10_000_000);
      this.detailPending.set(
        pending.map((c) => ({ id: c.id, tonnes: c.tonnes, status: c.status })),
      );
      this.detailHistory.set(
        history.map((c) => ({ id: c.id, tonnes: c.tonnes, status: c.status })),
      );
    } catch (err) {
      this.detailError.set(err instanceof Error ? err.message : 'Failed to load verifier details.');
    } finally {
      this.detailLoading.set(false);
    }
  }

  closeDetail(): void {
    this.selectedAddress.set(null);
    this.detailError.set(null);
    this.detailPending.set([]);
    this.detailHistory.set([]);
  }

  // ── Register modal ─────────────────────────────────────────────────────────

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

  // ── Configure modal ────────────────────────────────────────────────────────

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
      await this.load();
    } catch (err) {
      this.toast.show(err instanceof Error ? err.message : 'Configuration failed.', 'error');
    } finally {
      this.isConfiguring.set(false);
    }
  }

  // ── Suspend confirmation ───────────────────────────────────────────────────

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

  // ── Applications review (Issue #967) ───────────────────────────────────────

  async approveApplication(address: string): Promise<void> {
    const token = this.auth.token()!;
    try {
      await firstValueFrom(this.api.reviewVerifierApplication(address, 'approved', token));
      this.toast.show('Application approved.', 'success');
      await this.load();
    } catch (err) {
      this.toast.show(err instanceof Error ? err.message : 'Approval failed.', 'error');
    }
  }

  async rejectApplication(address: string): Promise<void> {
    const token = this.auth.token()!;
    try {
      await firstValueFrom(this.api.reviewVerifierApplication(address, 'rejected', token));
      this.toast.show('Application rejected.', 'info');
      await this.load();
    } catch (err) {
      this.toast.show(err instanceof Error ? err.message : 'Rejection failed.', 'error');
    }
  }
}
