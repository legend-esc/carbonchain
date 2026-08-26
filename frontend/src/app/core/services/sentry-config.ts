import * as Sentry from '@sentry/browser';

/**
 * Issue #543 — Production source map upload + release tracking.
 *
 * The release string is injected at build time by Angular CLI's `define`
 * option (see angular.json production configuration).  It is derived from
 * the git commit SHA so that every production deployment maps to a unique
 * Sentry release, enabling precise source-map resolution.
 *
 * Format: "<package-version>+<short-git-sha>"
 * e.g.   "1.0.0+a3f2b8c"
 *
 * Falls back to "unknown" when the build-time injection is absent (local dev
 * or test environments where the variable is not defined).
 */
function resolveRelease(): string {
  // __SENTRY_RELEASE__ is replaced by a string literal at build time via the
  // Angular CLI `define` option in the production build configuration.
  const buildTimeRelease =
    typeof (globalThis as Record<string, unknown>)['__SENTRY_RELEASE__'] === 'string'
      ? ((globalThis as Record<string, unknown>)['__SENTRY_RELEASE__'] as string)
      : '';

  return buildTimeRelease.trim() || 'unknown';
}

export function initSentry(dsn?: string | null): void {
  const resolvedDsn = (dsn ?? '').trim();
  if (!resolvedDsn) return;

  Sentry.init({
    dsn: resolvedDsn,
    // Issue #543: Tag every error event with the exact build that produced it.
    // The Sentry CLI upload step in CI uploads source maps under this same
    // release identifier so stack traces resolve to original TypeScript lines.
    release: resolveRelease(),
    integrations: [],
    tracesSampleRate: 0,
    enabled: true,
  });
}
