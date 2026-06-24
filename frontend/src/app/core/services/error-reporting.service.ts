import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, of } from 'rxjs';

export interface ErrorReport {
  message: string;
  stack?: string;
  url: string;
  timestamp: string;
}

@Injectable({ providedIn: 'root' })
export class ErrorReportingService {
  private readonly http = inject(HttpClient);
  private readonly endpoint = '/api/errors';

  report(error: unknown): void {
    const report: ErrorReport = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      url: typeof window !== 'undefined' ? window.location.href : '',
      timestamp: new Date().toISOString(),
    };

    this.http
      .post(this.endpoint, report)
      .pipe(catchError(() => of(null)))
      .subscribe();
  }
}
