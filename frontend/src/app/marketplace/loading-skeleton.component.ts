import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Standalone loading skeleton for the marketplace credit list.
 *
 * Additive component (not yet wired into marketplace.component.ts). Intended
 * usage: show `<app-marketplace-loading-skeleton>` while the GET
 * /api/v1/credits request is in flight, so the first paint isn't a blank
 * white screen during the ~1-2s fetch.
 */
@Component({
  selector: 'app-marketplace-loading-skeleton',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="skeleton-list" aria-busy="true" aria-live="polite">
      <div class="skeleton-card" *ngFor="let i of rows"></div>
    </div>
  `,
  styles: [
    `
      .skeleton-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .skeleton-card {
        height: 88px;
        border-radius: 8px;
        background: linear-gradient(90deg, #e8e8e8 25%, #f2f2f2 37%, #e8e8e8 63%);
        background-size: 400% 100%;
        animation: skeleton-shimmer 1.4s ease infinite;
      }
      @keyframes skeleton-shimmer {
        0% {
          background-position: 100% 50%;
        }
        100% {
          background-position: 0 50%;
        }
      }
    `,
  ],
})
export class MarketplaceLoadingSkeletonComponent {
  /** Number of placeholder rows to render while credits are loading. */
  @Input() count = 6;

  get rows(): number[] {
    return Array.from({ length: this.count }, (_, i) => i);
  }
}
