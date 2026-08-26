import { Injectable, inject, isDevMode } from '@angular/core';
import * as Sentry from '@sentry/browser';

export interface ErrorReport {
  message: string;
  stack?: string;
  url: string;
  timestamp: string;
}

@Injectable({ providedIn: 'root' })
export class ErrorReportingService {
  report(error: unknown): void {
    // Only report errors in production mode
    if (isDevMode()) return;

    // Gracefully no-op when DSN is not configured.
    // With @sentry/browser, Sentry.init() without a DSN is a no-op.
    try {
      Sentry.captureException(error);
    } catch {
      // never throw from error reporting
    }
  }
}
