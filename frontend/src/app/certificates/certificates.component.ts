import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { RetirementRecord } from '@shared';
import { ApiService, CertificateVerification } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { TranslationService } from '../core/services/translation.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-certificates',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  template: `
    <main class="certificate">
      @if (loading()) {
        <p>{{ 'certificate.loading' | translate }}</p>
      } @else if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (record()) {
        <h1>{{ 'certificate.title' | translate }}</h1>
        <dl>
          <dt>{{ 'certificate.id' | translate }}</dt>
          <dd>{{ record()!.id }}</dd>
          <dt>{{ 'certificate.creditId' | translate }}</dt>
          <dd>{{ record()!.credit_id }}</dd>
          <dt>{{ 'certificate.retiredBy' | translate }}</dt>
          <dd class="mono">{{ record()!.buyer }}</dd>
          <dt>{{ 'certificate.tonnes' | translate }}</dt>
          <dd>{{ tonnesDisplay() }}</dd>
          <dt>{{ 'certificate.reason' | translate }}</dt>
          <dd>{{ record()!.reason }}</dd>
          <dt>{{ 'certificate.retiredAt' | translate }}</dt>
          <dd>{{ record()!.retired_at | date: 'medium' }}</dd>
          <dt>{{ 'certificate.transaction' | translate }}</dt>
          <dd class="mono">{{ record()!.tx_hash }}</dd>
          @if (record()!.certificate_ipfs_hash) {
            <dt>{{ 'certificate.ipfs' | translate }}</dt>
            <dd class="mono">{{ record()!.certificate_ipfs_hash }}</dd>
          }
        </dl>

        <!-- Issue #544: on-chain certificate verification -->
        @if (verification()) {
          <div class="verify-result" [class.verified]="verification()!.verified">
            @if (verification()!.verified) {
              <span class="icon">✔</span>
              @if (verification()!.certificate_ipfs_hash) {
                {{
                  'certificate.verifiedWithIpfs'
                    | translate
                      : { hash: (verification()!.certificate_ipfs_hash ?? '' | slice: 0 : 16) }
                }}
              } @else {
                {{ 'certificate.verified' | translate }}
              }
            } @else {
              <span class="icon">✘</span> {{ 'certificate.verifyFailed' | translate }}
            }
          </div>
        }
        @if (verifyError()) {
          <p class="error">{{ verifyError() }}</p>
        }

        <div class="actions">
          <button [disabled]="downloading()" (click)="download()">
            {{ (downloading() ? 'certificate.downloading' : 'certificate.download') | translate }}
          </button>
          <button [disabled]="verifying()" (click)="verifyCertificate()" class="verify-btn">
            {{ (verifying() ? 'certificate.verifying' : 'certificate.verify') | translate }}
          </button>
        </div>
      }
    </main>
  `,
  styles: [
    `
      .certificate {
        padding: 2rem;
        max-width: 680px;
        margin: auto;
      }
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 0.4rem 1rem;
        margin-bottom: 1.5rem;
      }
      dt {
        font-weight: 600;
        color: #555;
      }
      .mono {
        font-family: monospace;
        font-size: 0.85rem;
        word-break: break-all;
      }
      .actions {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      button {
        padding: 0.5rem 1.25rem;
        background: #4caf50;
        color: #fff;
        border: none;
        border-radius: 6px;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .verify-btn {
        background: #1976d2;
      }
      .error {
        color: #e53935;
      }
      .verify-result {
        margin-bottom: 1rem;
        padding: 0.6rem 1rem;
        border-radius: 6px;
        background: #ffebee;
        color: #c62828;
      }
      .verify-result.verified {
        background: #e8f5e9;
        color: #2e7d32;
      }
      .icon {
        font-weight: bold;
        margin-right: 0.25rem;
      }
    `,
  ],
})
export class CertificatesComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(TranslationService);

  readonly record = signal<RetirementRecord | null>(null);
  readonly loading = signal(true);
  readonly downloading = signal(false);
  readonly verifying = signal(false);
  readonly error = signal<string | null>(null);
  readonly verifyError = signal<string | null>(null);
  readonly verification = signal<CertificateVerification | null>(null);

  readonly tonnesDisplay = () => {
    const r = this.record();
    if (!r) return '';
    return this.i18n.t('certificate.tonnesValue', {
      count: (BigInt(r.tonnes_retired) / 1_000_000n).toString(),
    });
  };

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id')!;
    try {
      this.record.set(await firstValueFrom(this.api.getRetirement(id)));
    } catch {
      this.error.set(this.i18n.t('certificate.notFound'));
    } finally {
      this.loading.set(false);
    }
  }

  async download(): Promise<void> {
    const id = this.record()!.id;
    this.downloading.set(true);
    try {
      const blob = await firstValueFrom(this.api.downloadCertificate(id, this.auth.token() ?? ''));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `certificate-${id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      this.error.set(this.i18n.t('certificate.downloadFailed'));
    } finally {
      this.downloading.set(false);
    }
  }

  /**
   * Issue #544 — Verify Certificate button.
   *
   * Calls GET /certificates/:id/verify which fetches the IPFS hash stored
   * on-chain via the Soroban retirement contract and returns it alongside
   * the verified flag.  The UI shows the on-chain CID so the user can
   * independently confirm the PDF content matches what was committed.
   */
  async verifyCertificate(): Promise<void> {
    const id = this.record()!.id;
    this.verifying.set(true);
    this.verifyError.set(null);
    this.verification.set(null);
    try {
      const result = await firstValueFrom(this.api.verifyCertificate(id));
      this.verification.set(result);
    } catch {
      this.verifyError.set(this.i18n.t('certificate.verifyError'));
    } finally {
      this.verifying.set(false);
    }
  }
}
