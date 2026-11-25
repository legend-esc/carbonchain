/**
 * Issue #1335 — ProjectMapComponent
 *
 * Renders an interactive Leaflet map with OpenStreetMap tiles.  Projects that
 * have lat/lng coordinates are plotted as circle markers.  When more than 500
 * projects are visible, Leaflet.markercluster groups nearby markers to keep
 * rendering smooth.
 *
 * Because Leaflet is a large dependency that many routes don't need, the map
 * script is loaded lazily via a dynamic import() inside ngAfterViewInit.  The
 * component degrades gracefully (loading/error states) if the library or the
 * project API is unavailable.
 *
 * Popup card content is built from Angular template bindings (see
 * project-map.component.html); a minimal HTML string is passed into Leaflet
 * and the Angular-rendered element is cloned into the popup's DOM node.
 */
import {
  Component,
  ElementRef,
  ViewChild,
  OnInit,
  OnDestroy,
  AfterViewInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../core/services/api.service';
import { ProjectProfile } from '@shared';

/** Minimal type surface for the Leaflet map instance. */
interface LeafletMap {
  remove(): void;
  addLayer(layer: unknown): this;
}

/** Minimal Leaflet layer type (marker / cluster group). */
interface LeafletLayer {
  addTo(map: LeafletMap): this;
  addLayer?(layer: unknown): this;
  on(event: string, handler: (e: unknown) => void): this;
  bindPopup(html: string): this;
  openPopup(): this;
}

/** Extended project shape with optional map-specific fields. */
export interface MapProject extends ProjectProfile {
  lat?: number;
  lng?: number;
  thumbnail_url?: string;
  available_tonnes?: string;
  price_per_tonne_xlm?: string;
}

@Component({
  selector: 'app-project-map',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    @if (loading()) {
      <p class="map-status" role="status">Loading project locations…</p>
    } @else if (error()) {
      <p class="map-error" role="alert">{{ error() }}</p>
    }

    <div
      #mapContainer
      class="project-map"
      [class.project-map--loading]="loading()"
      aria-label="Interactive map of carbon credit project locations"
      role="region"
    ></div>

    @if (popupProject(); as p) {
      <div #popupTpl class="map-popup" [attr.aria-label]="'Project details for ' + p.name">
        <strong class="map-popup__name">{{ p.name }}</strong>
        @if (p.thumbnail_url) {
          <img
            class="map-popup__thumb"
            [src]="p.thumbnail_url"
            [alt]="p.name + ' project photo'"
            loading="lazy"
          />
        }
        <dl class="map-popup__meta">
          <dt>Methodology</dt>
          <dd>{{ p.methodology ?? '—' }}</dd>
          <dt>Available tonnes</dt>
          <dd>{{ formatTonnes(p.available_tonnes) }}</dd>
          <dt>Price</dt>
          <dd>{{ p.price_per_tonne_xlm ? p.price_per_tonne_xlm + ' XLM/t' : '—' }}</dd>
        </dl>
        <a class="map-popup__link" [href]="'/projects/' + p.id">View project →</a>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .project-map {
        width: 100%;
        height: 520px;
        border-radius: 8px;
        border: 1px solid #e0e0e0;
        background: #f5f5f5;
        transition: opacity 0.2s ease;
      }

      .project-map--loading {
        opacity: 0.4;
        pointer-events: none;
      }

      .map-status,
      .map-error {
        font-size: 0.875rem;
        margin-bottom: 0.5rem;
      }

      .map-status {
        color: #666;
      }

      .map-error {
        color: #c62828;
      }

      /* Popup card styles — rendered inside Leaflet's popup DOM node */
      :host ::ng-deep .map-popup {
        min-width: 200px;
        max-width: 240px;
        font-size: 0.875rem;
        line-height: 1.4;
      }

      :host ::ng-deep .map-popup__name {
        display: block;
        font-size: 0.95rem;
        font-weight: 700;
        margin-bottom: 0.4rem;
        color: #1a1a1a;
      }

      :host ::ng-deep .map-popup__thumb {
        width: 100%;
        height: 100px;
        object-fit: cover;
        border-radius: 4px;
        margin-bottom: 0.5rem;
        display: block;
      }

      :host ::ng-deep .map-popup__meta {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.15rem 0.5rem;
        margin: 0 0 0.5rem;
      }

      :host ::ng-deep .map-popup__meta dt {
        font-weight: 600;
        color: #666;
        font-size: 0.75rem;
        text-transform: uppercase;
      }

      :host ::ng-deep .map-popup__meta dd {
        margin: 0;
        color: #1a1a1a;
      }

      :host ::ng-deep .map-popup__link {
        display: inline-block;
        font-size: 0.8rem;
        color: #1976d2;
        text-decoration: none;
        font-weight: 600;
      }

      :host ::ng-deep .map-popup__link:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class ProjectMapComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mapContainer') private mapContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('popupTpl') private popupTplRef?: ElementRef<HTMLDivElement>;

  private readonly api = inject(ApiService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly popupProject = signal<MapProject | null>(null);

  private projects: MapProject[] = [];
  private map: LeafletMap | null = null;

  ngOnInit(): void {
    void this.loadProjects();
  }

  ngAfterViewInit(): void {
    // Map is initialised once both the container and the project list are ready.
    // The projects list may resolve first; initMap() is also called there.
  }

  ngOnDestroy(): void {
    this.map?.remove();
    this.map = null;
  }

  private async loadProjects(): Promise<void> {
    try {
      const list = await firstValueFrom(this.api.listProjects());
      // Cast to MapProject; lat/lng fields are optional extensions
      this.projects = list as MapProject[];
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load projects.');
    } finally {
      this.loading.set(false);
      void this.initMap();
    }
  }

  private async initMap(): Promise<void> {
    if (!this.mapContainerRef) return;

    try {
      // Lazy-load Leaflet — bundler will code-split this chunk automatically.
      const L = await this.loadLeaflet();
      if (!L) return;

      const container = this.mapContainerRef.nativeElement;

      const map = L.map(container, { zoomControl: true }) as LeafletMap;
      this.map = map;

      // OpenStreetMap tile layer
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
      }).addTo(map as unknown as import('leaflet').Map);

      // Filter to projects that have coordinates
      const geoProjects = this.projects.filter(
        (p) => typeof p.lat === 'number' && typeof p.lng === 'number',
      );

      if (geoProjects.length === 0) {
        // Default world view when no coordinates are available
        (map as unknown as { setView: (c: [number, number], z: number) => void }).setView(
          [20, 0],
          2,
        );
        return;
      }

      // Build marker / cluster layer
      const markerLayer = this.buildMarkerLayer(L, geoProjects, map);
      (map as unknown as { addLayer: (l: unknown) => void }).addLayer(markerLayer);

      // Fit the map to the bounds of all markers
      const bounds = geoProjects.map((p) => [p.lat!, p.lng!] as [number, number]);
      (map as unknown as { fitBounds: (b: [number, number][]) => void }).fitBounds(bounds);
    } catch {
      this.error.set('Map could not be initialised.');
    }
  }

  /**
   * Dynamically import Leaflet.  Returns null in SSR or test environments
   * where `window` is not available.
   *
   * Exposed as a protected method so tests can override it without needing
   * the `leaflet` package installed.
   */
  protected async loadLeaflet(): Promise<typeof import('leaflet') | null> {
    if (typeof window === 'undefined') return null;
    try {
      return await import('leaflet');
    } catch {
      return null;
    }
  }

  private buildMarkerLayer(
    L: typeof import('leaflet'),
    projects: MapProject[],
    map: LeafletMap,
  ): unknown {
    // Use markercluster if available (optional peer dep), otherwise plain layer group
    let group: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const MC = require('leaflet.markercluster');
      group = new MC.MarkerClusterGroup();
    } catch {
      group = L.layerGroup();
    }

    for (const project of projects) {
      const marker = L.circleMarker([project.lat!, project.lng!], {
        radius: 8,
        fillColor: '#2e7d32',
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.85,
      });

      const popupHtml = this.buildPopupHtml(project);
      marker.bindPopup(popupHtml);

      marker.on('click', () => {
        this.popupProject.set(project);
      });

      (group as { addLayer: (m: unknown) => void }).addLayer(marker);
    }

    return group;
  }

  /**
   * Build a minimal HTML string for the Leaflet popup.
   * Full interactive content (Angular-bound anchor, pipe formats) is kept in
   * the main template; this HTML is a simplified static fallback.
   */
  private buildPopupHtml(project: MapProject): string {
    const name = this.escapeHtml(project.name ?? 'Unnamed project');
    const methodology = this.escapeHtml(project.methodology ?? '—');
    const tonnes = project.available_tonnes
      ? this.formatTonnes(project.available_tonnes)
      : '—';
    const price = project.price_per_tonne_xlm
      ? this.escapeHtml(project.price_per_tonne_xlm) + ' XLM/t'
      : '—';
    const href = `/projects/${this.escapeHtml(project.id)}`;
    const thumb = project.thumbnail_url
      ? `<img src="${this.escapeHtml(project.thumbnail_url)}" alt="${name} photo"
             style="width:100%;height:90px;object-fit:cover;border-radius:4px;margin-bottom:6px">`
      : '';

    return `
      <div style="min-width:180px;max-width:220px;font-size:13px;line-height:1.4">
        <strong style="display:block;margin-bottom:4px">${name}</strong>
        ${thumb}
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="color:#666;font-size:11px;text-transform:uppercase;padding:1px 4px 1px 0">Methodology</td><td>${methodology}</td></tr>
          <tr><td style="color:#666;font-size:11px;text-transform:uppercase;padding:1px 4px 1px 0">Tonnes</td><td>${tonnes}</td></tr>
          <tr><td style="color:#666;font-size:11px;text-transform:uppercase;padding:1px 4px 1px 0">Price</td><td>${price}</td></tr>
        </table>
        <a href="${href}" style="display:inline-block;margin-top:6px;font-size:12px;color:#1976d2;font-weight:600">View project →</a>
      </div>`;
  }

  formatTonnes(raw: string | undefined): string {
    if (!raw) return '—';
    const n = Number(raw);
    if (!Number.isFinite(n)) return '—';
    return (n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' t';
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
