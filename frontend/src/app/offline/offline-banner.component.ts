/**
 * Issue #1333 — OfflineBannerComponent
 *
 * Displays a non-intrusive banner at the top of the viewport:
 *   - "You're offline" while connectivity is lost
 *   - "Connection restored" for 2.5 s after reconnection
 *
 * The banner slides in and out with a CSS transition keyed on the state class.
 * Submit buttons in forms should check OfflineService.isOffline() to stay
 * disabled while offline.
 */
import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { OfflineService } from './offline.service';

@Component({
  selector: 'app-offline-banner',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (offline.bannerVisible()) {
      <div
        class="offline-banner"
        [class.offline-banner--offline]="offline.state() === 'offline'"
        [class.offline-banner--restored]="offline.state() === 'restored'"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        @if (offline.state() === 'offline') {
          <span class="offline-banner__icon" aria-hidden="true">📡</span>
          <span>You're offline — submit actions are disabled.</span>
        } @else {
          <span class="offline-banner__icon" aria-hidden="true">✅</span>
          <span>Connection restored.</span>
        }
      </div>
    }
  `,
  styles: [
    `
      .offline-banner {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        font-size: 0.875rem;
        font-weight: 500;
        text-align: center;
        animation: banner-slide-in 0.25s ease-out;
        /* Ensure the banner sits above the header backdrop but below modals */
        z-index: 900;
        position: relative;
      }

      .offline-banner--offline {
        background: #fef3c7;
        color: #92400e;
        border-bottom: 2px solid #f59e0b;
      }

      .offline-banner--restored {
        background: #d1fae5;
        color: #065f46;
        border-bottom: 2px solid #10b981;
      }

      .offline-banner__icon {
        font-size: 1rem;
        line-height: 1;
      }

      @keyframes banner-slide-in {
        from {
          transform: translateY(-100%);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
    `,
  ],
})
export class OfflineBannerComponent {
  protected readonly offline = inject(OfflineService);
}
