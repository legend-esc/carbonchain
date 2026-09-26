import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { RetirementRecord, CertificateVerification } from '@shared';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';

type VerifyState = 'idle' | 'loading' | 'verified' | 'failed' | 'error';

@Component({
  selector: 'app-certificates',
  standalone: true,
  imports: [CommonModule],
  template: `
    <main class="certificate">
      @if (loading()) {
        <p class="status">Loading certificate…</p>
      } @else if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      } @else if (record()) {
        <h1>Retirement Certificate</h1>

        <dl class="meta">
          <dt>Certificate ID</dt><dd class="mono">{{ record()!.id }}</dd>
          <dt>Credit ID</dt><dd class="mono">{{ record()!.credit_id }}</dd>
          <dt>Retired By</dt><dd class="mono">{{ record()!.buyer }}</dd>
          <dt>Tonnes Retired</dt><dd>{{ tonnesDisplay() }}</dd>
          <dt>Reason</dt><dd>{{ record()!.reason }}</dd>
          <dt>Retired At</dt><dd>{{ record()!.retired_at | date:'medium' }}</dd>
          <dt>Transaction</dt><dd class="mono small">{{ record()!.tx_hash }}</dd>
        </dl>

        <!-- PDF Preview section -->
        <section class="pdf-section" aria-label="Certificate PDF Preview">
          <h2>Certificate Preview</h2>
          @if (pdfLoading()) {
            <div class="pdf-placeholder" role="status">Loading PDF preview…</div>
          } @else if (pdfUrl()) {
            <iframe
              [src]="pdfUrl()!"
              class="pdf-frame"
              title="Retirement Certificate PDF Preview"
              aria-label="Retirement Certificate PDF Preview"
            ></iframe>
          } @else if (pdfError()) {
            <div class="pdf-placeholder error-box" role="alert">{{ pdfError() }}</div>
          }
          <div class="pdf-actions">
            <button
              class="btn btn-primary"
              [disabled]="downloading() || pdfLoading()"
              (click)="download()"
            >
              {{ downloading() ? 'Downloading…' : '⬇ Download PDF' }}
            </button>
            @if (!pdfUrl() && !pdfLoading()) {
              <button class="btn btn-outline" (click)="loadPdfPreview()">Preview PDF</button>
            }
          </div>
        </section>

        <!-- On-chain Verification Panel -->
        <section class="verify-section" aria-label="On-Chain Verification">
          <h2>On-Chain Verification</h2>
          @if (verifyState() === 'idle') {
            <button class="btn btn-outline" (click)="verifyOnChain()">Verify Certificate</button>
          } @else if (verifyState() === 'loading') {
            <p class="status" role="status">Verifying on-chain…</p>
          } @else if (verifyState() === 'verified' && verification()) {
            <div class="verify-result verify-ok" role="status">
              <span class="verify-icon" aria-hidden="true">✅</span>
              <div>
                <strong>Verified</strong>
                <dl class="verify-detail">
                  <dt>On-chain hash</dt>
                  <dd class="mono small">{{ verification()!.tx_hash }}</dd>
                  <dt>Ledger</dt>
                  <dd>{{ verification()!.ledger_sequence ?? 'N/A' }}</dd>
                  <dt>IPFS</dt>
                  <dd>{{ verification()!.ipfs_status ?? 'unknown' }}</dd>
                </dl>
              </div>
            </div>
          } @else if (verifyState() === 'failed' && verification()) {
            <div class="verify-result verify-fail" role="alert">
              <span class="verify-icon" aria-hidden="true">❌</span>
              <div>
                <strong>Verification Failed</strong>
                @if (verification()!.mismatch_reason) {
                  <p class="verify-reason">{{ verification()!.mismatch_reason }}</p>
                }
              </div>
            </div>
          } @else if (verifyState() === 'error') {
            <div class="verify-result verify-fail" role="alert">
              <span class="verify-icon" aria-hidden="true">⚠</span>
              <p>Could not reach the verification service. Please try again.</p>
            </div>
          }
          @if (verifyState() !== 'idle' && verifyState() !== 'loading') {
            <button class="btn btn-outline" style="margin-top:0.5rem" (click)="resetVerify()">
              Re-verify
            </button>
          }
        </section>
      }
    </main>
  `,
  styles: [`
    .certificate { padding: 2rem; max-width: 760px; margin: auto; }
    h1 { margin-bottom: 1.5rem; }
    h2 { font-size: 1.05rem; color: #333; margin: 1.5rem 0 0.5rem; }
    .meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; margin-bottom: 1.5rem; }
    dt { font-weight: 600; color: #555; }
    dd { margin: 0; }
    .mono { font-family: monospace; font-size: 0.85rem; word-break: break-all; }
    .small { font-size: 0.78rem; }
    .status { color: #888; }
    .error { color: #e53935; }
    .pdf-section, .verify-section {
      border-top: 1px solid #eee;
      padding-top: 1rem;
      margin-top: 1rem;
    }
    .pdf-frame {
      width: 100%;
      height: 480px;
      border: 1px solid #ddd;
      border-radius: 6px;
      margin-bottom: 0.75rem;
    }
    .pdf-placeholder {
      width: 100%;
      height: 160px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f5f5f5;
      border: 1px dashed #ccc;
      border-radius: 6px;
      color: #888;
      font-size: 0.9rem;
      margin-bottom: 0.75rem;
    }
    .error-box { color: #e53935; background: #ffebee; border-color: #ef9a9a; }
    .pdf-actions { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    .verify-result {
      display: flex;
      gap: 0.75rem;
      align-items: flex-start;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      margin-top: 0.5rem;
    }
    .verify-ok { background: #e8f5e9; }
    .verify-fail { background: #ffebee; }
    .verify-icon { font-size: 1.25rem; line-height: 1.4; }
    .verify-detail {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.3rem 0.75rem;
      font-size: 0.85rem;
      margin: 0.5rem 0 0;
    }
    .verify-reason { color: #c62828; font-size: 0.85rem; margin: 0.25rem 0 0; }
    .btn {
      padding: 0.5rem 1.25rem;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-primary { background: #4caf50; color: #fff; }
    .btn-outline { background: transparent; color: #333; border: 1px solid #ccc; }
  `],
})
export class CertificatesComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly record = signal<RetirementRecord | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  // PDF preview
  readonly pdfUrl = signal<string | null>(null);
  readonly pdfLoading = signal(false);
  readonly pdfError = signal<string | null>(null);
  readonly downloading = signal(false);

  // Verification
  readonly verifyState = signal<VerifyState>('idle');
  readonly verification = signal<CertificateVerification | null>(null);

  /** Tracks the object URL so we can revoke it on destroy. */
  private _pdfObjectUrl: string | null = null;

  readonly tonnesDisplay = () => {
    const r = this.record();
    if (!r) return '';
    return (BigInt(r.tonnes_retired) / 1_000_000n).toString() + ' tonnes';
  };

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id')!;
    try {
      this.record.set(await firstValueFrom(this.api.getRetirement(id)));
      // Auto-load the PDF preview once the record is available
      void this.loadPdfPreview();
    } catch {
      this.error.set('Certificate not found.');
    } finally {
      this.loading.set(false);
    }
  }

  ngOnDestroy(): void {
    // Free the blob URL to avoid memory leaks
    if (this._pdfObjectUrl) {
      URL.revokeObjectURL(this._pdfObjectUrl);
    }
  }

  /** Fetches the PDF blob and creates a local object URL for the iframe preview. */
  async loadPdfPreview(): Promise<void> {
    const id = this.record()?.id;
    if (!id) return;
    this.pdfLoading.set(true);
    this.pdfError.set(null);
    try {
      const blob = await firstValueFrom(
        this.api.downloadCertificate(id, this.auth.token() ?? ''),
      );
      // Revoke any previously created URL
      if (this._pdfObjectUrl) URL.revokeObjectURL(this._pdfObjectUrl);
      this._pdfObjectUrl = URL.createObjectURL(blob);
      this.pdfUrl.set(this._pdfObjectUrl);
    } catch {
      this.pdfError.set('PDF preview unavailable. You can still download the file.');
    } finally {
      this.pdfLoading.set(false);
    }
  }

  /** Downloads the PDF by creating a temporary <a> element. */
  async download(): Promise<void> {
    const id = this.record()!.id;
    this.downloading.set(true);
    try {
      const blob = await firstValueFrom(
        this.api.downloadCertificate(id, this.auth.token() ?? ''),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `certificate-${id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      this.error.set('Download failed. Please try again.');
    } finally {
      this.downloading.set(false);
    }
  }

  /** Calls the verification endpoint and displays the result. */
  async verifyOnChain(): Promise<void> {
    const id = this.record()!.id;
    this.verifyState.set('loading');
    this.verification.set(null);
    try {
      const result = await firstValueFrom(this.api.verifyCertificate(id));
      this.verification.set(result);
      this.verifyState.set(result.verified ? 'verified' : 'failed');
    } catch {
      this.verifyState.set('error');
    }
  }

  /** Resets the verification panel back to idle so the user can re-run it. */
  resetVerify(): void {
    this.verifyState.set('idle');
    this.verification.set(null);
  }
}
