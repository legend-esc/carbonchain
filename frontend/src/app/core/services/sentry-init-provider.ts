import { inject } from '@angular/core';
import { isDevMode } from '@angular/core';
import { initSentry } from './sentry-config';

// Angular will execute this factory during app bootstrap.
export function provideSentryInit() {
  return () => {
    // Only report errors in production mode
    if (isDevMode()) return;

    // Build-time env injection via Angular CLI define.
    const dsn = (window as any)?.__SENTRY_DSN__ as string | undefined;
    initSentry(dsn);
  };
}

export function useSentryInitFactory(): () => void {
  const runner = provideSentryInit();
  return runner;
}
