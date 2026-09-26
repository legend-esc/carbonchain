import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PwaInstallService } from '../services/pwa-install.service';
import { TranslatePipe } from '../pipes/translate.pipe';

/**
 * InstallPromptComponent - Shows a dismissible banner prompting users to install the app.
 * Displays on first visit if the app is installable and not already installed.
 */
@Component({
  selector: 'app-install-prompt',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  template: `
    <div
      *ngIf="(pwaInstall.showInstallPrompt | async) && !dismissed"
      class="install-prompt"
      role="banner"
      aria-live="polite"
    >
      <div class="install-prompt-content">
        <div class="install-prompt-icon">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>
        <div class="install-prompt-text">
          <h3>{{ 'pwa.install.title' | translate }}</h3>
          <p>{{ 'pwa.install.message' | translate }}</p>
        </div>
        <div class="install-prompt-actions">
          <button
            type="button"
            class="btn-install"
            (click)="install()"
            aria-label="Install CarbonChain app"
          >
            {{ 'pwa.install.button' | translate }}
          </button>
          <button
            type="button"
            class="btn-dismiss"
            (click)="dismiss()"
            aria-label="Dismiss install prompt"
          >
            {{ 'pwa.install.dismiss' | translate }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .install-prompt {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        max-width: 600px;
        width: calc(100% - 40px);
        background: var(--bg-card, #fff);
        border: 1px solid var(--border-color, #e5e7eb);
        border-radius: 12px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
        z-index: 1000;
        animation: slideUp 0.3s ease-out;
      }

      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translate(-50%, 20px);
        }
        to {
          opacity: 1;
          transform: translate(-50%, 0);
        }
      }

      .install-prompt-content {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 16px;
      }

      .install-prompt-icon {
        flex-shrink: 0;
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--primary-light, #e0f2fe);
        border-radius: 8px;
        color: var(--primary, #0284c7);
      }

      .install-prompt-text {
        flex: 1;
        min-width: 0;
      }

      .install-prompt-text h3 {
        margin: 0 0 4px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary, #111827);
      }

      .install-prompt-text p {
        margin: 0;
        font-size: 14px;
        color: var(--text-secondary, #6b7280);
      }

      .install-prompt-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex-shrink: 0;
      }

      .btn-install,
      .btn-dismiss {
        padding: 8px 16px;
        border: none;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
      }

      .btn-install {
        background: var(--primary, #0284c7);
        color: white;
      }

      .btn-install:hover {
        background: var(--primary-dark, #0369a1);
      }

      .btn-dismiss {
        background: transparent;
        color: var(--text-secondary, #6b7280);
      }

      .btn-dismiss:hover {
        background: var(--bg-hover, #f3f4f6);
      }

      @media (max-width: 640px) {
        .install-prompt {
          bottom: 10px;
          width: calc(100% - 20px);
        }

        .install-prompt-content {
          flex-wrap: wrap;
          gap: 12px;
        }

        .install-prompt-actions {
          flex-direction: row;
          width: 100%;
        }

        .btn-install,
        .btn-dismiss {
          flex: 1;
        }
      }
    `,
  ],
})
export class InstallPromptComponent {
  readonly pwaInstall = inject(PwaInstallService);
  dismissed = false;

  async install(): Promise<void> {
    const accepted = await this.pwaInstall.promptInstall();
    if (accepted) {
      this.dismissed = true;
    }
  }

  dismiss(): void {
    this.dismissed = true;
    this.pwaInstall.dismissPrompt();
  }
}
