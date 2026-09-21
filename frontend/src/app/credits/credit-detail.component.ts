import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CreditMetadata, CreditStatus } from '@shared';
import { ApiService, ProvenanceEvent } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { TranslationService } from '../core/services/translation.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { ProvenanceTimelineComponent } from './provenance-timeline.component';

@Component({
  selector: 'app-credit-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, ProvenanceTimelineComponent, TranslatePipe],
  template: `
    <div class="credit-detail">
      @if (loading()) {
        <p class="status">{{ 'credit.loading' | translate }}</p>
      } @else if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (credit()) {
        <div class="header">
          <h1>
            {{ 'credit.heading' | translate }}
            <span class="mono">{{ credit()!.id | slice: 0 : 16 }}…</span>
          </h1>
          <span class="badge" [class]="'badge-' + credit()!.status.toLowerCase()">{{
            credit()!.status
          }}</span>
        </div>

        <section class="card">
          <h2>{{ 'credit.metadata' | translate }}</h2>
          <dl>
            <dt>{{ 'credit.col.project' | translate }}</dt>
            <dd>{{ credit()!.project_id }}</dd>
            <dt>{{ 'credit.col.issuer' | translate }}</dt>
            <dd class="mono">{{ credit()!.issuer }}</dd>
            <dt>{{ 'credit.col.vintage' | translate }}</dt>
            <dd>{{ credit()!.vintage_year }}</dd>
            <dt>{{ 'credit.col.methodology' | translate }}</dt>
            <dd>{{ credit()!.methodology }}</dd>
            <dt>{{ 'credit.col.geography' | translate }}</dt>
            <dd>{{ credit()!.geography }}</dd>
            <dt>{{ 'credit.col.tonnes' | translate }}</dt>
            <dd>{{ formatTonnes(credit()!.tonnes) }}</dd>
            <dt>{{ 'credit.col.issuedAt' | translate }}</dt>
            <dd>{{ credit()!.issued_at | date: 'medium' }}</dd>
            <dt>{{ 'credit.col.ipfs' | translate }}</dt>
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
          <h2>{{ 'credit.provenance' | translate }}</h2>
          @if (provenanceLoading()) {
            <p class="status">{{ 'credit.loadingProvenance' | translate }}</p>
          } @else if (provenanceError()) {
            <p class="error">{{ provenanceError() }}</p>
          } @else if (provenance().length > 0) {
            <app-provenance-timeline [events]="provenance()" />
          } @else {
            <p class="status">{{ 'credit.noProvenance' | translate }}</p>
          }
        </section>

        <section class="card">
          <h2>{{ 'credit.mrvHistory' | translate }}</h2>
          @if (mrvHistory().length === 0) {
            <p class="status">{{ 'credit.noMrv' | translate }}</p>
          } @else {
            <table class="mrv-table">
              <thead>
                <tr>
                  <th>{{ 'credit.col.date' | translate }}</th>
                  <th>{{ 'credit.col.tonnesSequestered' | translate }}</th>
                  <th>{{ 'credit.col.oracle' | translate }}</th>
                  <th>{{ 'credit.col.anomaly' | translate }}</th>
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
          <div class="actions">
            <button
              class="btn btn-danger"
              (click)="retire()"
              [disabled]="credit()!.status !== 'Active'"
            >
              {{ 'credit.retire' | translate }}
            </button>
            <button
              class="btn btn-primary"
              (click)="sell()"
              [disabled]="credit()!.status !== 'Active'"
            >
              {{ 'credit.sell' | translate }}
            </button>
          </div>
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
        gap: 0.75rem;
        margin-top: 1rem;
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
      .btn-danger {
        background: #e53935;
        color: #fff;
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
    `,
  ],
})
export class CreditDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  private readonly i18n = inject(TranslationService);

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

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id')!;
    try {
      const credit = await firstValueFrom(this.api.getCredit(id));
      this.credit.set(credit);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : this.i18n.t('credit.loadError'));
    } finally {
      this.loading.set(false);
    }
    this.loadProvenance(id);
  }

  private async loadProvenance(id: string): Promise<void> {
    this.provenanceLoading.set(true);
    this.provenanceError.set(null);
    try {
      const events = await firstValueFrom(this.api.getCreditProvenance(id));
      this.provenance.set(events);
    } catch (err) {
      this.provenanceError.set(
        err instanceof Error ? err.message : this.i18n.t('credit.provenanceError'),
      );
    } finally {
      this.provenanceLoading.set(false);
    }
  }

  retire(): void {
    this.router.navigate(['/retire'], { queryParams: { creditId: this.credit()!.id } });
  }

  sell(): void {
    this.router.navigate(['/marketplace'], { queryParams: { sell: this.credit()!.id } });
  }

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' t';
  }
}
