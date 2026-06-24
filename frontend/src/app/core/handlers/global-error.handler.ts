import { ErrorHandler, Injectable, inject, NgZone } from '@angular/core';
import { ToastService } from '../services/toast.service';
import { ErrorReportingService } from '../services/error-reporting.service';

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly toast = inject(ToastService);
  private readonly reporter = inject(ErrorReportingService);
  private readonly zone = inject(NgZone);

  handleError(error: unknown): void {
    // Log to console for developer visibility
    console.error('[GlobalErrorHandler]', error);

    // Report to API error endpoint (fire-and-forget)
    this.reporter.report(error);

    // Show toast inside Angular zone so signal updates are detected
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.';

    this.zone.run(() => {
      this.toast.show(message, 'error');
    });
  }
}
