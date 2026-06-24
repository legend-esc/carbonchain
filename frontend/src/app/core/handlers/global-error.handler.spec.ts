import { TestBed } from '@angular/core/testing';
import { NgZone } from '@angular/core';
import { GlobalErrorHandler } from './global-error.handler';
import { ToastService } from '../services/toast.service';
import { ErrorReportingService } from '../services/error-reporting.service';

describe('GlobalErrorHandler', () => {
  let handler: GlobalErrorHandler;
  let toastSpy: ReturnType<typeof vi.fn>;
  let reportSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toastSpy = vi.fn();
    reportSpy = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        GlobalErrorHandler,
        { provide: ToastService, useValue: { show: toastSpy } },
        { provide: ErrorReportingService, useValue: { report: reportSpy } },
        // Use a synchronous NgZone so zone.run() executes immediately in tests
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
      ],
    });

    handler = TestBed.inject(GlobalErrorHandler);
  });

  it('creates the handler', () => {
    expect(handler).toBeTruthy();
  });

  it('calls ErrorReportingService.report() with the error', () => {
    const err = new Error('test error');
    handler.handleError(err);
    expect(reportSpy).toHaveBeenCalledWith(err);
  });

  it('shows a toast with the error message', () => {
    handler.handleError(new Error('boom'));
    expect(toastSpy).toHaveBeenCalledWith('boom', 'error');
  });

  it('shows a generic message for non-Error values', () => {
    handler.handleError('string error');
    expect(toastSpy).toHaveBeenCalledWith('An unexpected error occurred.', 'error');
  });

  it('shows a fallback message for null/undefined errors', () => {
    handler.handleError(null);
    expect(toastSpy).toHaveBeenCalledWith('An unexpected error occurred.', 'error');
  });

  it('reports non-Error values to the reporting service', () => {
    handler.handleError({ code: 42 });
    expect(reportSpy).toHaveBeenCalledWith({ code: 42 });
  });
});
