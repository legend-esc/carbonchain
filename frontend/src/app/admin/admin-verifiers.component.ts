import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { ApiService, VerifierRecord } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';

@Component({
  selector: 'app-admin-verifiers',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="verifiers">
      <h2>Verifier Management</h2>
      @if (loading()) {
        <p>Loading verifiers…</p>
      } @else {
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Name</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (v of verifiers(); track v.address) {
              <tr>
                <td class="mono">{{ v.address | slice:0:8 }}…{{ v.address | slice:-4 }}</td>
                <td>{{ v.name }}</td>
                <td>{{ v.status }}</td>
                <td class="actions">
                  @if (rowLoading().has(v.address)) {
                    <span class="spinner" aria-label="Loading"></span>
                  } @else {
                    @if (v.status !== 'approved') {
                      <button (click)="approve(v.address)">Approve</button>
                    }
                    @if (v.status !== 'removed') {
                      <button class="danger" (click)="remove(v.address)">Remove</button>
                    }
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
    </section>
  `,
  styles: [`
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #eee; }
    .mono { font-family: monospace; font-size: 0.85rem; }
    .actions { display: flex; gap: 0.5rem; align-items: center; }
    button { padding: 0.25rem 0.75rem; border-radius: 4px; border: none; cursor: pointer; background: #4caf50; color: #fff; }
    button.danger { background: #e53935; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #ccc; border-top-color: #4caf50; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error { color: #e53935; }
  `],
})
export class AdminVerifiersComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly verifiers = signal<VerifierRecord[]>([]);
  readonly loading = signal(true);
  readonly rowLoading = signal<Set<string>>(new Set());
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.listVerifiers(this.auth.token()!));
      this.verifiers.set(data);
    } catch {
      this.error.set('Failed to load verifiers.');
    } finally {
      this.loading.set(false);
    }
  }

  async approve(address: string): Promise<void> {
    await this.withRowLoading(address, async () => {
      await firstValueFrom(this.api.approveVerifier(address, this.auth.token()!));
      this.verifiers.update(list =>
        list.map(v => v.address === address ? { ...v, status: 'approved' } : v),
      );
    });
  }

  async remove(address: string): Promise<void> {
    await this.withRowLoading(address, async () => {
      await firstValueFrom(this.api.removeVerifier(address, this.auth.token()!));
      this.verifiers.update(list =>
        list.map(v => v.address === address ? { ...v, status: 'removed' } : v),
      );
    });
  }

  private async withRowLoading(address: string, fn: () => Promise<void>): Promise<void> {
    this.rowLoading.update(s => new Set([...s, address]));
    try {
      await fn();
    } catch {
      this.error.set(`Action failed for ${address}.`);
    } finally {
      this.rowLoading.update(s => { const n = new Set(s); n.delete(address); return n; });
    }
  }
}
