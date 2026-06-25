import * as Sentry from '@sentry/browser';

export function initSentry(dsn?: string | null): void {
  const resolvedDsn = (dsn ?? '').trim();
  if (!resolvedDsn) return;

  Sentry.init({
    dsn: resolvedDsn,
    integrations: [],
    tracesSampleRate: 0,
    enabled: true,
  });
}
