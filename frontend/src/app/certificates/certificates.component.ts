import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { RetirementRecord } from '@shared';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';

@Component({
  selector: 'app-certificates',
  standalone: true,
  imports: [CommonModule],
  template: `
    <main class="certificate">
      @if (loading()) {
        <p>Loading certificate…</p>
      } @else if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (record()) {
        <h1>Retirement Certificate</h1>
        <dl>
          <dt>Certificate ID</dt><dd>{{ record()!.id }}</dd>
          <dt>Credit ID</dt><dd>{{ record()!.credit_id }}</dd>
          <dt>Retired By</dt><dd class="mono">{{ record()!.buyer }}</dd>
          <dt>Tonnes Retired</dt><dd>{{ tonnesDisplay() }}</dd>
          <dt>Reason</dt><dd>{{ record()!.reason }}</dd>
          <dt>Retired At</dt><dd>{{ record()!.retired_at | date:'medium' }}</dd>
          <dt>Transaction</dt><dd class="mono">{{ record()!.tx_hash }}</dd>
        </dl>
        <button [disabled]="downloading()" (click)="download()">
          {{ downloading() ? 'Downloading…' : 'Download Certificate (PDF)' }}
        </button>
      }
    </main>
  `,
  styles: [`
    .certificate { padding: 2rem; max-width: 680px; margin: auto; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem; margin-bottom: 1.5rem; }
    dt { font-weight: 600; color: #555; }
    .mono { font-family: monospace; font-size: 0.85rem; word-break: break-all; }
    button { padding: 0.5rem 1.25rem; background: #4caf50; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .error { color: #e53935; }
  `],
})
export class CertificatesComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly record = signal<RetirementRecord | null>(null);
  readonly loading = signal(true);
  readonly downloading = signal(false);
  readonly error = signal<string | null>(null);

  readonly tonnesDisplay = () => {
    const r = this.record();
    if (!r) return '';
    return (BigInt(r.tonnes_retired) / 1_000_000n).toString() + ' tonnes';
  };

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id')!;
    try {
      this.record.set(await firstValueFrom(this.api.getRetirement(id)));
    } catch {
      this.error.set('Certificate not found.');
    } finally {
      this.loading.set(false);
    }
  }

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
      this.error.set('Download failed.');
    } finally {
      this.downloading.set(false);
    }
  }
}
