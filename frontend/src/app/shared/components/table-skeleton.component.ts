import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Issue #1354 — Reusable shimmer skeleton that matches the row structure of
 * the Marketplace, Portfolio, and Verifier tables. Each `columns` entry
 * describes one cell's relative width: 'wide' (flex 2), 'narrow' (flex 0.5),
 * or 'normal' (flex 1, the default).
 *
 * Usage:
 *   <app-table-skeleton [rows]="8" [columns]="['wide','normal','normal','narrow','narrow']" />
 */
export type SkeletonColWidth = 'wide' | 'normal' | 'narrow';

@Component({
  selector: 'app-table-skeleton',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="skeleton-wrapper"
      aria-busy="true"
      role="status"
      [attr.aria-label]="label()"
    >
      <!-- Faux header -->
      <div class="skeleton-header" aria-hidden="true">
        @for (col of columns(); track $index) {
          <div class="skeleton-cell skeleton-cell--header" [class]="colClass(col)"></div>
        }
      </div>

      <!-- Faux rows -->
      @for (row of rowArray(); track row) {
        <div class="skeleton-row" aria-hidden="true">
          @for (col of columns(); track $index) {
            <div
              class="skeleton-cell"
              [class]="colClass(col)"
              [style.animation-delay]="cellDelay(row)"
            ></div>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .skeleton-wrapper {
        display: flex;
        flex-direction: column;
        gap: 0;
        width: 100%;
        overflow: hidden;
        border-radius: 6px;
      }

      .skeleton-header {
        display: flex;
        gap: 0.75rem;
        padding: 0.6rem 0.8rem;
        background: #f0f0f0;
        border-bottom: 2px solid #e0e0e0;
      }

      .skeleton-row {
        display: flex;
        gap: 0.75rem;
        padding: 0.65rem 0.8rem;
        border-bottom: 1px solid #eee;
        transition: background 0.2s;
      }

      .skeleton-row:last-child {
        border-bottom: none;
      }

      /* Shimmer animation — single definition shared by all cells */
      .skeleton-cell {
        height: 14px;
        flex: 1;
        border-radius: 4px;
        background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
        background-size: 200% 100%;
        animation: cc-shimmer 1.4s infinite linear;
      }

      .skeleton-cell--header {
        height: 12px;
        opacity: 0.6;
      }

      .skeleton-cell--wide {
        flex: 2;
      }

      .skeleton-cell--narrow {
        flex: 0.5;
      }

      /* Respect prefers-reduced-motion — freeze the shimmer, keep the shapes */
      @media (prefers-reduced-motion: reduce) {
        .skeleton-cell {
          animation: none;
          background: #e8e8e8;
        }
      }

      @keyframes cc-shimmer {
        0% {
          background-position: 200% 0;
        }
        100% {
          background-position: -200% 0;
        }
      }
    `,
  ],
})
export class TableSkeletonComponent {
  /** Number of skeleton rows to render (default 6). */
  readonly rows = input<number>(6);

  /** Column width descriptors from left to right. */
  readonly columns = input<readonly SkeletonColWidth[]>(['wide', 'normal', 'normal', 'narrow', 'narrow']);

  /** Accessible label for screen readers. */
  readonly label = input<string>('Loading table data…');

  /** Derive a simple 0-based index array for @for iteration. */
  rowArray(): number[] {
    return Array.from({ length: this.rows() }, (_, i) => i);
  }

  colClass(width: SkeletonColWidth): string {
    if (width === 'wide') return 'skeleton-cell--wide';
    if (width === 'narrow') return 'skeleton-cell--narrow';
    return '';
  }

  /**
   * Stagger each row's animation by 0.08 s so the shimmer wave cascades
   * down the table instead of all rows pulsing in unison.
   */
  cellDelay(rowIndex: number): string {
    return `${(rowIndex * 0.08).toFixed(2)}s`;
  }
}
