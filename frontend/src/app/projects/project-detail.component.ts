import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ProjectProfile, CreditMetadata, MrvDataPoint } from '@shared';
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

        <section class="card mrv-section" aria-label="MRV monitoring data">
          <h2>MRV Monitoring</h2>

          @if (mrvLoading()) {
            <p class="status">Loading MRV data…</p>
          } @else if (mrvError()) {
            <p class="alert alert--error" role="alert">{{ mrvError() }}</p>
          } @else if (mrvAggregate()) {
            @if (mrvAggregate()!.anomalyCount > 0) {
              <p class="alert alert--warning" role="alert">
                ⚠ {{ mrvAggregate()!.anomalyCount }} anomalous reading{{
                  mrvAggregate()!.anomalyCount === 1 ? '' : 's'
                }}
                detected.
              </p>
            }

            <div class="mrv-stats">
              <div class="mrv-stat">
                <span class="mrv-stat-label">Total Sequestered</span>
                <span class="mrv-stat-value">{{ formatTonnes(mrvAggregate()!.totalTonnes) }}</span>
              </div>
              <div class="mrv-stat">
                <span class="mrv-stat-label">Readings</span>
                <span class="mrv-stat-value">{{ mrvAggregate()!.readingCount }}</span>
              </div>
              <div class="mrv-stat">
                <span class="mrv-stat-label">Anomalies</span>
                <span class="mrv-stat-value">{{ mrvAggregate()!.anomalyCount }}</span>
              </div>
              @if (mrvAggregate()!.latestReading) {
                <div class="mrv-stat">
                  <span class="mrv-stat-label">Latest Reading</span>
                  <span class="mrv-stat-value">{{
                    formatDate(mrvAggregate()!.latestReading!.measurement_date)
                  }}</span>
                </div>
              }
            </div>

            @if (mrvHistory().length > 0) {
              <h3 class="mrv-subtitle">History</h3>
              <svg
                class="mrv-chart"
                [attr.width]="mrvChartWidth"
                [attr.height]="mrvChartHeight"
                role="img"
                aria-label="MRV sequestration history line chart"
              >
                <title>Sequestered tonnes over time</title>
                @for (pt of mrvChartPoints(); track pt.measurement_date; let i = $index) {
                  <circle
                    [attr.cx]="pt.x"
                    [attr.cy]="pt.y"
                    r="3"
                    fill="#1565c0"
                    [attr.aria-label]="
                      formatDate(pt.measurement_date) + ': ' + formatTonnes(pt.tonnes_sequestered)
                    "
                  />
                  @if (i > 0) {
                    <line
                      [attr.x1]="mrvChartPoints()[i - 1].x"
                      [attr.y1]="mrvChartPoints()[i - 1].y"
                      [attr.x2]="pt.x"
                      [attr.y2]="pt.y"
                      stroke="#1565c0"
                      stroke-width="1.5"
                    />
                  }
                }
              </svg>
              <ul class="mrv-legend">
                @for (pt of mrvHistory(); track pt.measurement_date) {
                  <li>
                    <span class="mono">{{ formatDate(pt.measurement_date) }}</span>
                    <span>{{ formatTonnes(pt.tonnes_sequestered) }}</span>
                    @if (pt.anomaly_flag) {
                      <span class="badge badge-flagged">Anomaly</span>
                    }
                  </li>
                }
              </ul>
            }
          } @else {
            <p class="status">No MRV data available for this project yet.</p>
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      .project-detail {
        max-width: 900px;
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
      h3 {
        margin: 1rem 0 0.5rem;
        font-size: 0.9rem;
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
      .alert--warning {
        background: #fff3cd;
        color: #856404;
        border: 1px solid #ffeaa7;
      }

      .mrv-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 1rem;
        margin-bottom: 1.25rem;
      }
      .mrv-stat {
        background: #e3f2fd;
        border: 1px solid #90caf9;
        border-radius: 8px;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .mrv-stat-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: #555;
        text-transform: uppercase;
      }
      .mrv-stat-value {
        font-size: 1.25rem;
        font-weight: 700;
        color: #1a1a1a;
      }

      .mrv-chart {
        display: block;
        margin-bottom: 1rem;
      }
      .mrv-legend {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .mrv-legend li {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        font-size: 0.85rem;
        padding: 0.35rem 0.5rem;
        background: #f5f5f5;
        border-radius: 4px;
      }
      .mrv-subtitle {
        margin-top: 1.25rem;
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

  readonly mrvLoading = signal(false);
  readonly mrvError = signal<string | null>(null);
  readonly mrvHistory = signal<MrvDataPoint[]>([]);
  readonly mrvAggregate = signal<{
    totalTonnes: string;
    readingCount: number;
    anomalyCount: number;
    latestReading: MrvDataPoint | null;
    monthlyBreakdown: {
      month: string;
      totalTonnes: string;
      readingCount: number;
      anomalyCount: number;
    }[];
  } | null>(null);

  readonly mrvChartWidth = 640;
  readonly mrvChartHeight = 200;
  readonly mrvPaddingLeft = 40;
  readonly mrvPaddingRight = 20;
  readonly mrvPaddingTop = 20;
  readonly mrvPaddingBottom = 30;

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id')!;
    this.loadProject(id);
    this.loadMrv(id);
  }

  async loadProject(id: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
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

  private async loadMrv(projectId: string): Promise<void> {
    this.mrvLoading.set(true);
    this.mrvError.set(null);
    try {
      const [historyResp, aggregate] = await Promise.all([
        firstValueFrom(this.api.getOracleHistory(projectId, 1, 100)),
        firstValueFrom(this.api.getOracleAggregate(projectId)),
      ]);
      this.mrvHistory.set(historyResp.data);
      this.mrvAggregate.set(aggregate);
    } catch {
      this.mrvError.set('Failed to load MRV data.');
    } finally {
      this.mrvLoading.set(false);
    }
  }

  formatTonnes(raw: string): string {
    return (
      (Number(BigInt(raw)) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 }) +
      ' t'
    );
  }

  formatDate(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString();
  }

  readonly mrvChartPoints = computed(() => {
    const points = this.mrvHistory();
    if (points.length === 0)
      return [] as { x: number; y: number; measurement_date: number; tonnes_sequestered: string }[];

    const width = this.mrvChartWidth - this.mrvPaddingLeft - this.mrvPaddingRight;
    const height = this.mrvChartHeight - this.mrvPaddingTop - this.mrvPaddingBottom;
    const minTs = Math.min(...points.map((p) => p.measurement_date));
    const maxTs = Math.max(...points.map((p) => p.measurement_date));
    const tsRange = maxTs - minTs || 1;
    const maxTonnes = Math.max(...points.map((p) => Number(BigInt(p.tonnes_sequestered))));

    return points.map((pt) => {
      const x = this.mrvPaddingLeft + ((pt.measurement_date - minTs) / tsRange) * width;
      const tonnes = Number(BigInt(pt.tonnes_sequestered));
      const y = this.mrvPaddingTop + height - (maxTonnes > 0 ? (tonnes / maxTonnes) * height : 0);
      return {
        x,
        y,
        measurement_date: pt.measurement_date,
        tonnes_sequestered: pt.tonnes_sequestered,
      };
    });
  });
}
