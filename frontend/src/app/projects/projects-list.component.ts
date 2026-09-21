import { CommonModule } from '@angular/common';
import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/services/api.service';
import { TranslationService } from '../core/services/translation.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { firstValueFrom } from 'rxjs';
import { ProjectProfile } from '@shared';
import { CreditStatus } from '@shared';

@Component({
  selector: 'app-projects-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TranslatePipe],
  template: `
    <div class="projects">
      <div class="projects__toolbar">
        <h1>{{ 'projects.title' | translate }}</h1>
        <div class="projects__filters">
          <label class="field">
            <span>{{ 'projects.search' | translate }}</span>
            <input
              type="search"
              [placeholder]="'projects.searchPlaceholder' | translate"
              [ngModel]="searchTerm()"
              (ngModelChange)="searchTerm.set($event); onSearchChanged()"
            />
          </label>

          <label class="field">
            <span>{{ 'projects.methodology' | translate }}</span>
            <select
              [ngModel]="selectedMethodology()"
              (ngModelChange)="selectedMethodology.set($event); onFiltersChanged()"
            >
              <option [ngValue]="''">{{ 'projects.all' | translate }}</option>
              @for (m of methodologies(); track m) {
                <option [ngValue]="m">{{ m }}</option>
              }
            </select>
          </label>
        </div>
      </div>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      } @else if (loading()) {
        <p class="status">{{ 'projects.loading' | translate }}</p>
      } @else if (filteredProjects().length === 0) {
        <p class="status">{{ 'projects.noMatch' | translate }}</p>
      } @else {
        <table class="projects-table" [attr.aria-label]="'projects.tableAria' | translate">
          <thead>
            <tr>
              <th scope="col">{{ 'projects.col.name' | translate }}</th>
              <th scope="col">{{ 'projects.col.developer' | translate }}</th>
              <th scope="col">{{ 'projects.col.location' | translate }}</th>
              <th scope="col">{{ 'projects.col.methodology' | translate }}</th>
              <th scope="col">{{ 'projects.col.documents' | translate }}</th>
            </tr>
          </thead>
          <tbody>
            @for (p of filteredProjects(); track p.id) {
              <tr class="projects-row">
                <td>
                  <a class="link" [routerLink]="['/projects', p.id]">{{ p.name }}</a>
                </td>
                <td>{{ p.developer }}</td>
                <td>{{ p.location }}</td>
                <td>
                  <span class="methodology">{{ p.methodology }}</span>
                </td>
                <td>
                  @if (p.documents_cid) {
                    <a
                      class="link"
                      [href]="'https://ipfs.io/ipfs/' + p.documents_cid"
                      target="_blank"
                      rel="noopener"
                    >
                      {{ 'projects.view' | translate }}
                    </a>
                  } @else {
                    <span class="muted">—</span>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: [
    `
      .projects {
        max-width: 1000px;
        margin: 0 auto;
        padding: 0 1rem;
      }
      .projects__toolbar {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        margin: 1rem 0 1rem;
        flex-wrap: wrap;
      }
      h1 {
        margin: 0;
        font-size: 1.4rem;
      }
      .projects__filters {
        display: flex;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 220px;
      }
      input,
      select {
        padding: 0.5rem 0.6rem;
        border-radius: 8px;
        border: 1px solid #e0e0e0;
        background: #fff;
        font-size: 0.9rem;
      }
      .status {
        color: #888;
      }
      .error {
        color: #e53935;
      }
      .projects-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.92rem;
      }
      .projects-table th,
      .projects-table td {
        padding: 0.65rem 0.8rem;
        border-bottom: 1px solid #eee;
        text-align: left;
        vertical-align: top;
      }
      .projects-table th {
        background: #f5f5f5;
        font-weight: 600;
      }
      .projects-row:hover {
        background: #fafafa;
      }
      .link {
        color: #1976d2;
        text-decoration: none;
      }
      .link:hover {
        text-decoration: underline;
      }
      .muted {
        color: #888;
      }
      .methodology {
        font-weight: 600;
      }
    `,
  ],
})
export class ProjectsListComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly i18n = inject(TranslationService);

  readonly projects = signal<ProjectProfile[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly searchTerm = signal('');
  readonly selectedMethodology = signal('');

  readonly methodologies = computed(() => {
    const set = new Set<string>();
    for (const p of this.projects()) {
      if (p.methodology) set.add(p.methodology);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  });

  readonly filteredProjects = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const m = this.selectedMethodology();

    return this.projects().filter((p) => {
      const matchesTerm = !term || (p.name ?? '').toLowerCase().includes(term);
      const matchesMethodology = !m || p.methodology === m;
      return matchesTerm && matchesMethodology;
    });
  });

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const list = await firstValueFrom(this.api.listProjects());
      this.projects.set(list);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : this.i18n.t('projects.loadError'));
    } finally {
      this.loading.set(false);
    }
  }

  onSearchChanged(): void {
    // computed() will re-evaluate; handler exists for readability
  }

  onFiltersChanged(): void {
    // computed() will re-evaluate
  }
}
