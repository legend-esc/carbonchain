import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ProjectProfile, CreditMetadata } from '@shared';
import { ApiService } from '../core/services/api.service';

@Component({
  selector: 'app-project-detail',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <div class="project-detail">
      @if (loading()) {
        <p class="status">Loading project…</p>
      } @else if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (project()) {
        <h1>{{ project()!.name }}</h1>

        <section class="card">
          <h2>Project Metadata</h2>
          <dl>
            <dt>Developer</dt>
            <dd>{{ project()!.developer }}</dd>
            <dt>Location</dt>
            <dd>{{ project()!.location }}</dd>
            <dt>Methodology</dt>
            <dd>{{ project()!.methodology }}</dd>
            <dt>Description</dt>
            <dd>{{ project()!.description }}</dd>
          </dl>
        </section>

        <section class="card">
          <h2>IPFS Documents</h2>
          @if (project()!.documents_cid) {
            <a
              class="ipfs-link"
              [href]="'https://ipfs.io/ipfs/' + project()!.documents_cid"
              target="_blank"
              rel="noopener"
            >
              📄 View Project Documents ({{ project()!.documents_cid | slice: 0 : 20 }}…)
            </a>
          } @else {
            <p class="status">No documents uploaded.</p>
          }
        </section>

        <section class="card">
          <h2>Linked Credits</h2>
          @if (creditsLoading()) {
            <p class="status">Loading credits…</p>
          } @else if (credits().length === 0) {
            <p class="status">No credits issued for this project.</p>
          } @else {
            <table class="credits-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Vintage</th>
                  <th>Tonnes</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                @for (c of credits(); track c.id) {
                  <tr>
                    <td>
                      <a [routerLink]="['/credits', c.id]" class="mono"
                        >{{ c.id | slice: 0 : 12 }}…</a
                      >
                    </td>
                    <td>{{ c.vintage_year }}</td>
                    <td>{{ formatTonnes(c.tonnes) }}</td>
                    <td>
                      <span class="badge" [class]="'badge-' + c.status.toLowerCase()">{{
                        c.status
                      }}</span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      .project-detail {
        max-width: 800px;
        margin: 0 auto;
      }
      h1 {
        margin-bottom: 1.5rem;
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
        grid-template-columns: 130px 1fr;
        gap: 0.4rem 1rem;
        font-size: 0.9rem;
      }
      dt {
        font-weight: 600;
        color: #666;
      }
      .ipfs-link {
        font-size: 0.9rem;
        color: #1976d2;
        text-decoration: none;
      }
      .ipfs-link:hover {
        text-decoration: underline;
      }
      .credits-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.85rem;
      }
      .credits-table th,
      .credits-table td {
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid #eee;
        text-align: left;
      }
      .credits-table th {
        background: #f0f0f0;
        font-weight: 600;
      }
      .mono {
        font-family: monospace;
      }
      a {
        color: #1976d2;
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      .badge {
        padding: 0.2rem 0.5rem;
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
        font-size: 0.9rem;
      }
      .error {
        color: #e53935;
      }
    `,
  ],
})
export class ProjectDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);

  readonly project = signal<ProjectProfile | null>(null);
  readonly credits = signal<CreditMetadata[]>([]);
  readonly loading = signal(true);
  readonly creditsLoading = signal(false);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id')!;
    try {
      const project = await firstValueFrom(this.api.getProject(id));
      this.project.set(project);
      await this.loadCredits(id);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load project.');
    } finally {
      this.loading.set(false);
    }
  }

  private async loadCredits(projectId: string): Promise<void> {
    this.creditsLoading.set(true);
    try {
      const ids = await firstValueFrom(this.api.listCreditsByProject(projectId));
      const credits = await Promise.all(ids.map((id) => firstValueFrom(this.api.getCredit(id))));
      this.credits.set(credits);
    } catch {
      // non-fatal: credits section shows empty state
    } finally {
      this.creditsLoading.set(false);
    }
  }

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' t';
  }
}
