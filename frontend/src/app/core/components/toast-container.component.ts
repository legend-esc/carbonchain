/**
 * Issue #1336 — ToastContainerComponent
 *
 * Renders the global toast queue from ToastService.  Each toast may contain:
 *  - A plain text message
 *  - A `txHash` → auto-renders a "View on StellarExpert" link
 *  - An `action` → renders an extra button or link beside the dismiss control
 *
 * Accessibility:
 *  - Container has role="region" and aria-label so it is reachable by landmark
 *    navigation.
 *  - Each individual toast has role="alert" (assertive) for errors and
 *    role="status" (polite) for success/info/warning, matching the ARIA spec.
 */
import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService, STELLAR_EXPERT_TX_BASE, Toast } from '../services/toast.service';

@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="toast-container" role="region" aria-label="Notifications" aria-live="polite">
      @for (toast of toastService.toasts(); track toast.id) {
        <div
          class="toast"
          [class]="'toast toast--' + toast.type"
          [attr.role]="toast.type === 'error' ? 'alert' : 'status'"
          [attr.aria-atomic]="true"
        >
          <span class="toast__message">{{ toast.message }}</span>

          <div class="toast__actions">
            <!-- Transaction explorer link -->
            @if (toast.txHash) {
              <a
                class="toast__action-link"
                [href]="explorerUrl(toast)"
                target="_blank"
                rel="noopener noreferrer"
                [attr.aria-label]="'View transaction ' + toast.txHash + ' on StellarExpert'"
              >
                View on StellarExpert ↗
              </a>
            }

            <!-- Optional arbitrary action -->
            @if (toast.action) {
              @if (toast.action.href) {
                <a
                  class="toast__action-link"
                  [href]="toast.action.href"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ toast.action.label }}
                </a>
              } @else {
                <button class="toast__action-btn" type="button" (click)="toast.action.onClick?.()">
                  {{ toast.action.label }}
                </button>
              }
            }

            <button
              class="toast__close"
              type="button"
              (click)="toastService.dismiss(toast.id)"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .toast-container {
        position: fixed;
        bottom: 1.5rem;
        right: 1.5rem;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        max-width: 26rem;
        pointer-events: none;
      }

      .toast {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
        border-radius: 0.5rem;
        font-size: 0.875rem;
        line-height: 1.4;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        animation: slide-in 0.2s ease-out;
        pointer-events: auto;
      }

      .toast--error {
        background: #fee2e2;
        color: #991b1b;
        border-left: 4px solid #ef4444;
      }

      .toast--info {
        background: #dbeafe;
        color: #1e40af;
        border-left: 4px solid #3b82f6;
      }

      .toast--success {
        background: #dcfce7;
        color: #166534;
        border-left: 4px solid #22c55e;
      }

      .toast--warning {
        background: #fef3c7;
        color: #92400e;
        border-left: 4px solid #f59e0b;
      }

      .toast__message {
        flex: 1;
      }

      .toast__actions {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-shrink: 0;
        flex-wrap: wrap;
      }

      .toast__action-link {
        font-size: 0.75rem;
        font-weight: 600;
        text-decoration: underline;
        color: inherit;
        white-space: nowrap;
      }

      .toast__action-btn {
        background: none;
        border: 1px solid currentColor;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.75rem;
        font-weight: 600;
        padding: 0.1rem 0.4rem;
        color: inherit;
      }

      .toast__action-btn:hover {
        opacity: 0.8;
      }

      .toast__close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 0.75rem;
        opacity: 0.6;
        padding: 0;
        line-height: 1;
        color: inherit;
      }

      .toast__close:hover {
        opacity: 1;
      }

      @keyframes slide-in {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
    `,
  ],
})
export class ToastContainerComponent {
  protected readonly toastService = inject(ToastService);

  explorerUrl(toast: Toast): string {
    return `${STELLAR_EXPERT_TX_BASE}${toast.txHash}`;
  }
}
