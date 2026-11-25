import { Component, inject, signal, computed, OnInit, ElementRef, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { ToastService } from '../core/services/toast.service';

export interface ProjectBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface ImageryPair {
  baselineUrl: string; // before (baseline year)
  currentUrl: string; // after  (vintage year)
  baselineYear: number;
  vintageYear: number;
  geoJson?: string; // project polygon GeoJSON (optional)
  projectBounds?: ProjectBounds;
}

type RejectStep = 'idle' | 'open' | 'submitting';

/** #1329 — Split-screen satellite imagery slider for forestry credit verification. */
@Component({
  selector: 'app-verifier-inspection',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  template: `
    <div class="workbench" aria-label="Verifier inspection workbench">
      <!-- Header -->
      <div class="wb-header">
        <div class="wb-title-row">
          <h1>Verifier Inspection Workbench</h1>
          @if (projectId()) {
            <span class="project-badge">Project: {{ projectId() }}</span>
          }
        </div>
        <a routerLink="/verifier/apply" class="btn btn-outline btn-sm">← Back</a>
      </div>

      @if (loading()) {
        <p class="status" role="status">Loading project imagery…</p>
      } @else if (loadError()) {
        <p class="alert alert--error" role="alert">{{ loadError() }}</p>
      } @else if (!imagery()) {
        <p class="status">No imagery available for this project.</p>
      } @else {
        <!-- Year labels -->
        <div class="year-labels" aria-hidden="true">
          <span class="year-label">{{ imagery()!.baselineYear }} (Baseline)</span>
          <span class="year-label year-label--right">{{ imagery()!.vintageYear }} (Vintage)</span>
        </div>

        <!-- Split-screen slider -->
        <div
          class="slider-wrap"
          #sliderWrap
          (mousedown)="onDragStart($event)"
          (touchstart)="onTouchStart($event)"
          (mousemove)="onDragMove($event)"
          (touchmove)="onTouchMove($event)"
          (mouseup)="onDragEnd()"
          (mouseleave)="onDragEnd()"
          (touchend)="onDragEnd()"
          role="img"
          [attr.aria-label]="
            'Side-by-side satellite comparison. ' +
            imagery()!.baselineYear +
            ' on left, ' +
            imagery()!.vintageYear +
            ' on right. Drag to compare.'
          "
        >
          <!-- Current (vintage) image — full width, behind -->
          <div class="imagery-layer imagery-current">
            @if (imagery()!.currentUrl) {
              <img
                [src]="imagery()!.currentUrl"
                alt="Current satellite imagery ({{ imagery()!.vintageYear }})"
                class="sat-img"
                (error)="onImgError('current')"
              />
            } @else {
              <div class="img-placeholder">No current imagery</div>
            }
          </div>

          <!-- Baseline image — clipped by slider -->
          <div class="imagery-layer imagery-baseline" [style.clip-path]="baselineClip()">
            @if (imagery()!.baselineUrl) {
              <img
                [src]="imagery()!.baselineUrl"
                alt="Baseline satellite imagery ({{ imagery()!.baselineYear }})"
                class="sat-img"
                (error)="onImgError('baseline')"
              />
            } @else {
              <div class="img-placeholder">No baseline imagery</div>
            }
          </div>

          <!-- Project polygon overlay (simple CSS bounding box) -->
          @if (imagery()!.projectBounds) {
            <div
              class="polygon-overlay"
              [style]="polygonStyle()"
              aria-label="Project boundary polygon"
              role="presentation"
            ></div>
          }

          <!-- Divider handle -->
          <div class="divider" [style.left]="sliderPct() + '%'" aria-hidden="true">
            <div class="divider-line"></div>
            <div class="divider-handle">⟺</div>
          </div>
        </div>

        <!-- Slider range input (accessible fallback) -->
        <label class="sr-only" for="slider-range">Slide to compare imagery</label>
        <input
          id="slider-range"
          type="range"
          min="0"
          max="100"
          step="0.5"
          [(ngModel)]="sliderValue"
          (ngModelChange)="onSliderChange($event)"
          class="slider-input"
          aria-label="Comparison slider position"
        />
        <div class="slider-hint" aria-hidden="true">← Drag or use slider to compare →</div>

        <!-- GeoJSON info -->
        @if (imagery()!.geoJson) {
          <details class="geojson-details">
            <summary>Project GeoJSON Boundary</summary>
            <pre class="geojson-pre">{{ imagery()!.geoJson }}</pre>
          </details>
        }

        <!-- Action buttons -->
        <div class="action-row">
          <button
            class="btn btn-approve"
            type="button"
            (click)="approveProject()"
            [disabled]="actionSubmitting()"
          >
            {{ actionSubmitting() && actionType() === 'approve' ? 'Approving…' : '✓ Approve' }}
          </button>
          <button
            class="btn btn-reject"
            type="button"
            (click)="openRejectModal()"
            [disabled]="actionSubmitting()"
          >
            ✗ Reject
          </button>
        </div>

        @if (actionSuccess()) {
          <p class="alert alert--success" role="status">{{ actionSuccess() }}</p>
        }
        @if (actionError()) {
          <p class="alert alert--error" role="alert">{{ actionError() }}</p>
        }
      }

      <!-- Reject reason modal -->
      @if (rejectStep() === 'open' || rejectStep() === 'submitting') {
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reject-title">
          <div class="modal" (keydown.escape)="closeRejectModal()">
            <h2 id="reject-title">Reject Project</h2>
            <p class="modal-desc">Please provide a reason for rejection.</p>

            <label class="field-label" for="reject-reason">Reason</label>
            <textarea
              id="reject-reason"
              class="text-input"
              rows="4"
              placeholder="Describe the issue…"
              [(ngModel)]="rejectReason"
              [attr.aria-invalid]="
                !rejectReason.trim() && rejectStep() === 'submitting' ? 'true' : null
              "
            ></textarea>

            @if (!rejectReason.trim() && rejectStep() === 'submitting') {
              <span class="field-error" role="alert">A reason is required.</span>
            }

            <div class="modal-actions">
              <button
                class="btn btn-outline"
                type="button"
                (click)="closeRejectModal()"
                [disabled]="rejectStep() === 'submitting'"
              >
                Cancel
              </button>
              <button
                class="btn btn-reject"
                type="button"
                (click)="submitReject()"
                [disabled]="rejectStep() === 'submitting'"
              >
                {{ rejectStep() === 'submitting' ? 'Submitting…' : 'Submit Rejection' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .workbench {
        max-width: 900px;
        margin: 0 auto;
        padding: 1.5rem 1rem;
      }

      .wb-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 1rem;
        gap: 1rem;
        flex-wrap: wrap;
      }

      .wb-title-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      .wb-title-row h1 {
        margin: 0;
        font-size: 1.25rem;
        color: var(--text, #1a1a2e);
      }

      .project-badge {
        font-size: 0.75rem;
        background: var(--surface, #f0f0f0);
        border: 1px solid var(--border, #ddd);
        padding: 0.2rem 0.6rem;
        border-radius: 999px;
        color: var(--text-muted, #555);
      }

      /* Year labels */
      .year-labels {
        display: flex;
        justify-content: space-between;
        margin-bottom: 0.4rem;
      }

      .year-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-muted, #555);
        background: var(--surface, #f0f0f0);
        padding: 0.15rem 0.5rem;
        border-radius: 4px;
      }

      .year-label--right {
        text-align: right;
      }

      /* Slider container */
      .slider-wrap {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        overflow: hidden;
        border-radius: 8px;
        border: 1px solid var(--border, #ddd);
        cursor: col-resize;
        user-select: none;
        touch-action: none;
        background: #222;
      }

      /* Image layers */
      .imagery-layer {
        position: absolute;
        inset: 0;
      }

      .sat-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        pointer-events: none;
      }

      .img-placeholder {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #333;
        color: #aaa;
        font-size: 0.875rem;
      }

      /* Polygon overlay — bounding-box rectangle */
      .polygon-overlay {
        position: absolute;
        border: 2px solid #ffeb3b;
        border-radius: 2px;
        pointer-events: none;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
      }

      /* Divider */
      .divider {
        position: absolute;
        top: 0;
        bottom: 0;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        z-index: 10;
      }

      .divider-line {
        width: 2px;
        flex: 1;
        background: white;
        box-shadow: 0 0 4px rgba(0, 0, 0, 0.5);
      }

      .divider-handle {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1rem;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        pointer-events: none;
      }

      /* Range input */
      .slider-input {
        width: 100%;
        margin-top: 0.6rem;
        accent-color: var(--accent, #4caf50);
      }

      .slider-hint {
        text-align: center;
        font-size: 0.75rem;
        color: var(--text-muted, #888);
        margin-top: 0.25rem;
      }

      /* GeoJSON details */
      .geojson-details {
        margin-top: 1rem;
        font-size: 0.8rem;
        color: var(--text-muted, #555);
      }

      .geojson-pre {
        margin: 0.5rem 0 0;
        background: var(--surface, #f5f5f5);
        border: 1px solid var(--border, #ddd);
        border-radius: 4px;
        padding: 0.75rem;
        overflow-x: auto;
        font-size: 0.75rem;
        max-height: 200px;
      }

      /* Action row */
      .action-row {
        display: flex;
        gap: 1rem;
        margin-top: 1.25rem;
        flex-wrap: wrap;
      }

      .btn {
        padding: 0.6rem 1.5rem;
        border-radius: 6px;
        font-weight: 600;
        font-size: 0.9rem;
        cursor: pointer;
        border: 1px solid transparent;
        transition: opacity 0.15s;
        text-decoration: none;
      }

      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .btn:focus-visible {
        outline: 2px solid var(--accent, #4caf50);
        outline-offset: 2px;
      }

      .btn-approve {
        background: #2e7d32;
        color: #fff;
        border-color: #2e7d32;
      }

      .btn-approve:hover:not(:disabled) {
        opacity: 0.88;
      }

      .btn-reject {
        background: #c62828;
        color: #fff;
        border-color: #c62828;
      }

      .btn-reject:hover:not(:disabled) {
        opacity: 0.88;
      }

      .btn-outline {
        background: transparent;
        color: var(--text, #1a1a2e);
        border-color: var(--border, #ddd);
      }

      .btn-outline:hover:not(:disabled) {
        background: var(--surface, #f5f5f5);
      }

      .btn-sm {
        padding: 0.35rem 0.9rem;
        font-size: 0.8rem;
      }

      /* Alerts */
      .status {
        color: var(--text-muted, #888);
      }

      .alert {
        padding: 0.75rem 1rem;
        border-radius: 6px;
        font-size: 0.875rem;
        margin-top: 0.75rem;
      }

      .alert--error {
        background: #ffebee;
        color: #c62828;
        border: 1px solid #ef9a9a;
      }

      .alert--success {
        background: #e8f5e9;
        color: #2e7d32;
        border: 1px solid #a5d6a7;
      }

      /* Modal */
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        padding: 1rem;
      }

      .modal {
        background: var(--bg, #fff);
        border-radius: 8px;
        padding: 1.5rem;
        max-width: 480px;
        width: 100%;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
      }

      .modal h2 {
        margin: 0 0 0.5rem;
        font-size: 1.1rem;
        color: var(--text, #1a1a2e);
      }

      .modal-desc {
        font-size: 0.875rem;
        color: var(--text-muted, #555);
        margin: 0 0 1rem;
      }

      .field-label {
        display: block;
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text, #1a1a2e);
        margin-bottom: 0.3rem;
      }

      .text-input {
        width: 100%;
        padding: 0.6rem 0.75rem;
        border: 1px solid var(--border, #ddd);
        border-radius: 6px;
        font-size: 0.9rem;
        background: var(--bg, #fff);
        color: var(--text, #1a1a2e);
        box-sizing: border-box;
        resize: vertical;
      }

      .text-input:focus-visible {
        outline: 2px solid var(--accent, #4caf50);
        outline-offset: 2px;
      }

      .field-error {
        font-size: 0.8rem;
        color: #c62828;
        display: block;
        margin-top: 0.25rem;
      }

      .modal-actions {
        display: flex;
        gap: 0.75rem;
        justify-content: flex-end;
        margin-top: 1rem;
      }

      /* Utility */
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class VerifierInspectionComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  readonly projectId = signal<string | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly imagery = signal<ImageryPair | null>(null);
  readonly actionSubmitting = signal(false);
  readonly actionType = signal<'approve' | 'reject' | null>(null);
  readonly actionSuccess = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);

  // Slider state
  sliderValue = 50;
  private dragging = false;
  readonly _sliderPct = signal(50);
  readonly sliderPct = this._sliderPct.asReadonly();

  // Reject modal
  readonly rejectStep = signal<RejectStep>('idle');
  rejectReason = '';

  readonly baselineClip = computed(() => `inset(0 ${100 - this._sliderPct()}% 0 0)`);

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('projectId');
    this.projectId.set(id);
    if (!id) {
      this.loadError.set('No project ID provided.');
      this.loading.set(false);
      return;
    }
    await this.loadImagery(id);
  }

  private async loadImagery(projectId: string): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      // The API may not have a dedicated imagery endpoint yet; use project
      // profile data to derive placeholder Mapbox/Bing tile URLs from bounds.
      const project = await firstValueFrom(this.api.getProject(projectId));
      // Derive pseudo-imagery URLs from project data for display purposes.
      // Real implementations would call a dedicated satellite imagery endpoint.
      const baseYear = 2018;
      const vintageYear = new Date().getFullYear() - 1;
      this.imagery.set({
        baselineUrl: this.buildTileUrl(project.location, baseYear),
        currentUrl: this.buildTileUrl(project.location, vintageYear),
        baselineYear: baseYear,
        vintageYear,
        geoJson: JSON.stringify({
          type: 'Feature',
          properties: { name: project.name },
          geometry: null,
        }),
        projectBounds: this.parseBounds(project.location),
      });
    } catch {
      this.loadError.set('Could not load project imagery. The project may not exist.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Builds a placeholder satellite tile URL. In production this would use
   * actual Mapbox, Planet, or Sentinel tile endpoints with real coordinates.
   */
  private buildTileUrl(location: string, year: number): string {
    // Use a neutral placeholder that doesn't require API keys in development
    return `https://picsum.photos/seed/${encodeURIComponent(location + year)}/900/506`;
  }

  private parseBounds(location: string): ProjectBounds | undefined {
    // Rough bounding box approximation for display — real data would come from
    // the project GeoJSON. If location is a country code, use known bounds.
    const knownBounds: Record<string, ProjectBounds> = {
      BR: { north: 5, south: -34, east: -34, west: -74 },
      KE: { north: 5, south: -5, east: 42, west: 34 },
      IN: { north: 37, south: 8, east: 97, west: 68 },
    };
    return knownBounds[location.toUpperCase().slice(0, 2)];
  }

  polygonStyle(): string {
    const bounds = this.imagery()?.projectBounds;
    if (!bounds) return '';
    // Convert geo bounds to percentage CSS positions within the tile image
    // (simplified linear mapping — good enough for a demo overlay)
    const latRange = 90;
    const lngRange = 180;
    const top = ((90 - bounds.north) / latRange) * 100;
    const left = ((bounds.west + 180) / (lngRange * 2)) * 100;
    const height = ((bounds.north - bounds.south) / latRange) * 100;
    const width = ((bounds.east - bounds.west) / (lngRange * 2)) * 100;
    return `top:${top}%; left:${left}%; height:${height}%; width:${width}%;`;
  }

  // ── Slider drag handling ───────────────────────────────────────────────────

  onSliderChange(val: number): void {
    this._sliderPct.set(val);
  }

  onDragStart(event: MouseEvent): void {
    this.dragging = true;
    this.updateSliderFromEvent(event);
  }

  onTouchStart(event: TouchEvent): void {
    this.dragging = true;
    this.updateSliderFromTouch(event);
  }

  onDragMove(event: MouseEvent): void {
    if (!this.dragging) return;
    this.updateSliderFromEvent(event);
  }

  onTouchMove(event: TouchEvent): void {
    if (!this.dragging) return;
    this.updateSliderFromTouch(event);
  }

  onDragEnd(): void {
    this.dragging = false;
  }

  private updateSliderFromEvent(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    this._sliderPct.set(pct);
    this.sliderValue = pct;
  }

  private updateSliderFromTouch(event: TouchEvent): void {
    const touch = event.touches[0];
    if (!touch) return;
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100));
    this._sliderPct.set(pct);
    this.sliderValue = pct;
  }

  onImgError(which: 'baseline' | 'current'): void {
    // Silently handled — the img-placeholder already shows via @else in template
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  async approveProject(): Promise<void> {
    const id = this.projectId();
    const token = this.auth.token();
    if (!id || !token) return;

    this.actionSubmitting.set(true);
    this.actionType.set('approve');
    this.actionError.set(null);
    this.actionSuccess.set(null);

    try {
      await firstValueFrom(this.api.reviewVerifierApplication(id, 'approved', token));
      this.actionSuccess.set(`Project ${id} approved successfully.`);
      this.toast.showSuccess('Project approved.');
    } catch {
      this.actionError.set('Approval failed. Please try again.');
    } finally {
      this.actionSubmitting.set(false);
      this.actionType.set(null);
    }
  }

  openRejectModal(): void {
    this.rejectReason = '';
    this.rejectStep.set('open');
  }

  closeRejectModal(): void {
    if (this.rejectStep() === 'submitting') return;
    this.rejectStep.set('idle');
  }

  async submitReject(): Promise<void> {
    if (!this.rejectReason.trim()) {
      this.rejectStep.set('submitting');
      return;
    }

    const id = this.projectId();
    const token = this.auth.token();
    if (!id || !token) return;

    this.rejectStep.set('submitting');
    this.actionError.set(null);
    this.actionSuccess.set(null);

    try {
      await firstValueFrom(this.api.reviewVerifierApplication(id, 'rejected', token));
      this.rejectStep.set('idle');
      this.actionSuccess.set(`Project ${id} rejected.`);
      this.toast.showSuccess('Project rejected.');
    } catch {
      this.rejectStep.set('open');
      this.actionError.set('Rejection failed. Please try again.');
    }
  }
}
