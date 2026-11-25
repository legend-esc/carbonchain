import { Component, computed, effect, inject, input, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

export type VerificationStatus =
  'idle' | 'downloading' | 'hashing' | 'verified' | 'mismatch' | 'error';

const SHA256_WORKER_SOURCE = `
self.onmessage = async (event) => {
  try {
    const buffer = event.data;
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    self.postMessage({ hash: hex });
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : 'SHA-256 hashing failed' });
  }
};
`;

@Component({
  selector: 'app-ipfs-document-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ipfs-document-viewer.component.html',
  styles: [
    `
      .ipfs-viewer {
        border: 1px solid #e0e7e3;
        border-radius: 8px;
        padding: 1rem;
        background: #fff;
      }
      .viewer-header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 0.85rem;
      }
      .viewer-title-group h3 {
        margin: 0 0 0.25rem;
        font-size: 1rem;
      }
      .gateway-link {
        font-size: 0.85rem;
        color: #1b5e20;
        text-decoration: none;
      }
      .gateway-link:hover {
        text-decoration: underline;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        padding: 0.3rem 0.7rem;
        border-radius: 999px;
        font-size: 0.8rem;
        font-weight: 700;
      }
      .badge--pending {
        background: #f3f4f6;
        color: #374151;
      }
      .badge--verified {
        background: #e8f5e9;
        color: #1b5e20;
        border: 1px solid #a5d6a7;
      }
      .badge--mismatch {
        background: #ffebee;
        color: #b71c1c;
        border: 1px solid #ef9a9a;
      }
      .badge--error {
        background: #fff3e0;
        color: #e65100;
        border: 1px solid #ffcc80;
      }
      .hash-details {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.35rem 1rem;
        background: #f9fafb;
        padding: 0.75rem;
        border-radius: 6px;
        font-size: 0.82rem;
        margin: 0 0 0.85rem;
      }
      dt {
        color: #555;
        font-weight: 600;
      }
      dd {
        margin: 0;
        word-break: break-all;
      }
      .mono {
        font-family: monospace;
      }
      .alert {
        border-radius: 6px;
        padding: 0.75rem 1rem;
        font-size: 0.875rem;
      }
      .alert--mismatch {
        background: #ffebee;
        color: #b71c1c;
        border: 1px solid #ef9a9a;
      }
      .alert--error {
        background: #fff3e0;
        color: #bf360c;
        border: 1px solid #ffcc80;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
      }
      .alert--error p {
        margin: 0;
      }
      .btn-retry,
      .btn-download {
        padding: 0.4rem 0.85rem;
        border-radius: 6px;
        border: 1px solid #1b5e20;
        background: #1b5e20;
        color: #fff;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        text-decoration: none;
      }
      .preview-container {
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        overflow: hidden;
        background: #f9fafb;
      }
      .preview-frame {
        width: 100%;
        height: 480px;
        border: 0;
      }
      .preview-image {
        display: block;
        max-width: 100%;
        max-height: 480px;
        margin: 0 auto;
      }
      .preview-download {
        padding: 1.5rem;
        text-align: center;
      }
    `,
  ],
})
export class IpfsDocumentViewerComponent implements OnDestroy {
  private readonly sanitizer = inject(DomSanitizer);

  readonly cid = input.required<string>();
  readonly expectedHash = input.required<string>();
  readonly gatewayUrl = input<string>('https://ipfs.io/ipfs');
  readonly title = input<string>('Project Audit Document');

  readonly status = signal<VerificationStatus>('idle');
  readonly computedHash = signal<string | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly previewUrl = signal<SafeResourceUrl | null>(null);
  readonly contentType = signal<string | null>(null);
  readonly fileSizeBytes = signal<number | null>(null);

  private objectUrl: string | null = null;
  private activeRequestId = 0;

  readonly documentUrl = computed(() => {
    const base = this.gatewayUrl().replace(/\/+$/, '');
    return `${base}/${this.cid()}`;
  });

  readonly normalizedExpectedHash = computed(() =>
    this.expectedHash()
      .trim()
      .replace(/^(0x|sha256:)/i, '')
      .toLowerCase(),
  );

  readonly isPdf = computed(() => (this.contentType() ?? '').includes('application/pdf'));
  readonly isImage = computed(() => (this.contentType() ?? '').startsWith('image/'));

  constructor() {
    effect(() => {
      // Re-verify automatically when cid or expectedHash changes.
      const currentCid = this.cid();
      const currentHash = this.expectedHash();
      if (currentCid && currentHash) {
        void this.verifyAndPreview();
      }
    });
  }

  ngOnDestroy(): void {
    this.revokeObjectUrl();
  }

  async verifyAndPreview(): Promise<void> {
    const requestId = ++this.activeRequestId;
    this.revokeObjectUrl();
    this.computedHash.set(null);
    this.errorMessage.set(null);
    this.contentType.set(null);
    this.fileSizeBytes.set(null);
    this.status.set('downloading');

    try {
      const response = await fetch(this.documentUrl());
      if (requestId !== this.activeRequestId) return;

      if (!response.ok) {
        throw new Error(`IPFS gateway returned HTTP ${response.status}`);
      }

      const blob = await response.blob();
      if (requestId !== this.activeRequestId) return;

      this.contentType.set(blob.type || response.headers.get('content-type') || '');
      this.fileSizeBytes.set(blob.size);
      this.status.set('hashing');

      const buffer = await blob.arrayBuffer();
      const digestHex = await this.computeSha256InWorker(buffer);
      if (requestId !== this.activeRequestId) return;

      this.computedHash.set(digestHex);
      if (digestHex === this.normalizedExpectedHash()) {
        this.objectUrl = URL.createObjectURL(blob);
        this.previewUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(this.objectUrl));
        this.status.set('verified');
      } else {
        this.status.set('mismatch');
      }
    } catch (err) {
      if (requestId !== this.activeRequestId) return;
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Unable to download or verify document.',
      );
      this.status.set('error');
    }
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }

  private async computeSha256InWorker(buffer: ArrayBuffer): Promise<string> {
    if (typeof Worker === 'undefined') {
      return this.computeSha256Fallback(buffer);
    }

    const workerBlob = new Blob([SHA256_WORKER_SOURCE], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);

    try {
      return await new Promise<string>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<{ hash?: string; error?: string }>) => {
          if (event.data.error) {
            reject(new Error(event.data.error));
          } else if (event.data.hash) {
            resolve(event.data.hash);
          } else {
            reject(new Error('Unexpected worker response.'));
          }
        };
        worker.onerror = (err) => reject(new Error(err.message || 'WebWorker hashing failed.'));
        // Transfer the ArrayBuffer so hashing runs off the main thread without copying.
        worker.postMessage(buffer, [buffer]);
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  }

  private async computeSha256Fallback(buffer: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.previewUrl.set(null);
  }
}
