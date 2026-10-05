import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { ApiService } from '../core/services/api.service';
import { ToastService } from '../core/services/toast.service';

@Component({
  selector: 'app-verifier-status',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  template: `
    <div class="verifier-status">
      <h1 class="page-title">Verifier Application Status</h1>

      @if (!address()) {
        <p class="status">Loading…</p>
      } @else {
        <div class="lookup-form">
          <label class="field-label" for="status-address">Stellar Address</label>
          <div class="lookup-row">
            <input
              id="status-address"
              class="text-input"
              type="text"
              placeholder="G…"
              [(ngModel)]="address"
              name="address"
            />
            <button class="btn btn-primary" (click)="check()">Check Status</button>
          </div>
        </div>

        @if (loading()) {
          <p class="status">Checking…</p>
        } @else if (error()) {
          <p class="alert alert--error" role="alert">{{ error() }}</p>
        } @else if (app()) {
          <div class="status-card">
            <h2>Application for {{ app()!.name || app()!.address }}</h2>
            <p class="mono">{{ app()!.address }}</p>
            <p>
              Status:
              <span class="badge" [class]="statusClass(app()!.status)">{{ app()!.status }}</span>
            </p>
            @if (app()!.reviewedBy) {
              <p>Reviewed by: {{ app()!.reviewedBy }}</p>
            }
            <p class="meta">Submitted: {{ app()!.createdAt | date: 'medium' }}</p>
            @if (app()!.updatedAt) {
              <p class="meta">Last updated: {{ app()!.updatedAt | date: 'medium' }}</p>
            }

            @if (app()!.status === 'pending') {
              <div class="stake-preview">
                <h3>Commitment Summary</h3>
                <p>Documents CID: {{ app()!.documentsCid }}</p>
                <p>Stake token: {{ app()!.stakeToken }}</p>
                <p>Stake amount: {{ app()!.stakeAmount }} stroops</p>
              </div>
            }
          </div>
        } @else if (searched()) {
          <p class="status">No application found for this address.</p>
        }
      }
    </div>
  `,
  styles: [
    `
      .verifier-status {
        max-width: 640px;
        margin: 2rem auto;
        padding: 0 1rem;
      }
      .page-title {
        margin: 0 0 1.5rem;
        font-size: 1.5rem;
      }
      .lookup-form {
        margin-bottom: 1.5rem;
      }
      .lookup-row {
        display: flex;
        gap: 0.75rem;
      }
      .lookup-row .text-input {
        flex: 1;
      }
      .text-input {
        padding: 0.55rem 0.75rem;
        border: 1px solid #bbb;
        border-radius: 6px;
        font-size: 0.95rem;
        font-family: monospace;
      }
      .field-label {
        display: block;
        font-size: 0.85rem;
        font-weight: 600;
        margin-bottom: 0.35rem;
      }
      .status-card {
        background: #f9f9f9;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        padding: 1.25rem;
      }
      .status-card h2 {
        margin: 0 0 0.5rem;
        font-size: 1.1rem;
      }
      .mono {
        font-family: monospace;
        font-size: 0.9rem;
        color: #555;
      }
      .badge {
        padding: 0.2rem 0.5rem;
        border-radius: 4px;
        font-size: 0.75rem;
        text-transform: uppercase;
        font-weight: 600;
      }
      .badge-pending {
        background: #fff8e1;
        color: #f57f17;
      }
      .badge-approved {
        background: #e8f5e9;
        color: #2e7d32;
      }
      .badge-rejected {
        background: #ffebee;
        color: #c62828;
      }
      .meta {
        font-size: 0.85rem;
        color: #666;
      }
      .stake-preview {
        margin-top: 1rem;
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
        margin: 0.25rem 0;
        font-size: 0.9rem;
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
      .status {
        color: #888;
        font-size: 0.95rem;
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
    `,
  ],
})
export class VerifierStatusComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly address = signal('');
  readonly app = signal<{
    address: string;
    name: string | null;
    capabilities: string[];
    documentsCid: string | null;
    stakeToken: string | null;
    stakeAmount: string | null;
    status: string;
    reviewedBy: string | null;
    createdAt: number;
    updatedAt: number | null;
  } | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly searched = signal(false);

  ngOnInit(): void {
    const addr = this.route.snapshot.paramMap.get('address');
    if (addr) {
      this.address.set(addr);
      void this.check();
    }
  }

  async check(): Promise<void> {
    const addr = this.address().trim();
    if (!addr) return;
    this.loading.set(true);
    this.error.set(null);
    this.searched.set(true);
    try {
      const result = await firstValueFrom(this.api.getVerifierApplication(addr));
      this.app.set(
        result
          ? {
              address: result.address,
              name: result.name,
              capabilities: result.capabilities,
              documentsCid: result.documentsCid,
              stakeToken: result.stakeToken,
              stakeAmount: result.stakeAmount,
              status: result.status,
              reviewedBy: result.reviewedBy,
              createdAt:
                typeof result.createdAt === 'number'
                  ? result.createdAt
                  : (result.createdAt as any).getTime() / 1000,
              updatedAt: result.updatedAt
                ? typeof result.updatedAt === 'number'
                  ? result.updatedAt
                  : (result.updatedAt as any).getTime() / 1000
                : null,
            }
          : null,
      );
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load application.');
    } finally {
      this.loading.set(false);
    }
  }

  statusClass(status: string): string {
    switch (status) {
      case 'pending':
        return 'badge-pending';
      case 'approved':
        return 'badge-approved';
      case 'rejected':
        return 'badge-rejected';
      default:
        return '';
    }
  }
}
