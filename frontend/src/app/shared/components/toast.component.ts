import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-toast',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="toast-container" role="alert" aria-live="polite" aria-atomic="true">
      @for (toast of toastService.toasts(); track toast.id) {
        <div class="toast" [class]="'toast toast--' + toast.type" role="alert">
          <span class="toast__message">{{ toast.message }}</span>
          <button
            class="toast__close"
            (click)="toastService.dismiss(toast.id)"
            aria-label="Dismiss notification"
          >
            ✕
          </button>
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
        max-width: 24rem;
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

      .toast__message {
        flex: 1;
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
export class ToastComponent {
  protected readonly toastService = inject(ToastService);
}
