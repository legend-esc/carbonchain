import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { OnlineStatusService } from '../core/services/online-status.service';

@Component({
  selector: 'app-offline',
  standalone: true,
  template: `
    <main class="offline">
      <h1>You're offline</h1>
      <p>
        Check your connection. Certificates and credit pages you've already opened
        are still available.
      </p>
      <button (click)="retry()">Retry</button>
    </main>
  `,
  styles: [
    `
      .offline {
        padding: 3rem 1.5rem;
        text-align: center;
        max-width: 480px;
        margin: auto;
      }
      button {
        margin-top: 1rem;
        padding: 0.5rem 1.25rem;
        border-radius: 6px;
        border: none;
        background: #4caf50;
        color: #fff;
        cursor: pointer;
      }
    `,
  ],
})
export class OfflineComponent {
  private readonly router = inject(Router);
  private readonly onlineStatus = inject(OnlineStatusService);

  retry(): void {
    if (this.onlineStatus.online()) {
      this.router.navigate(['/dashboard']);
    }
  }
}
