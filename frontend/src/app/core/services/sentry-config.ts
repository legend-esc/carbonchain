import * as Sentry from '@sentry/browser';

/**
 * Issue #543 / #971 — Production source-map upload + release tracking.
 *
 * The release string is injected at build time by Angular CLI's `define` option
 * (see angular.json production configuration).  The Vite-based builder
 * (`@angular/build:application`) evaluates the `define` expression at compile
 * time, replacing every occurrence of the identifier `__SENTRY_RELEASE__` with
 * the result of `JSON.stringify(process.env['SENTRY_RELEASE'] || '')`.
 *
 * The CI workflow (`ci.yml`) computes a single RELEASE id once:
 *
 *   RELEASE="${PKG_VERSION}+${SHORT_SHA}"   # e.g. "1.0.0+a3f2b8c"
 *
 * and passes it as the `SENTRY_RELEASE` environment variable to both the
 * Angular build step and the `sentry-cli releases files $RELEASE ...` upload
 * step, guaranteeing the runtime bundle and the uploaded source maps share the
 * exact same release identifier.
 *
 * A post-build assertion in CI (`Assert runtime release matches computed
 * RELEASE`) greps the compiled chunks for the release string and fails the
 * build if they do not match, preventing a "leaked/partial release" regression.
 *
 * Falls back to `'unknown'` in local dev / test environments where the
 * `SENTRY_RELEASE` env var is not set.
 */

// `__SENTRY_RELEASE__` is replaced by a string literal at build time by the
// Angular CLI `define` option. In tests / dev the declaration below provides
// a type-safe fallback so TypeScript does not complain.
declare const __SENTRY_RELEASE__: string | undefined;

function resolveRelease(): string {
  try {
    // This branch is taken in production builds — `__SENTRY_RELEASE__` is a
    // string literal after Vite substitution.
    if (typeof __SENTRY_RELEASE__ === 'string' && __SENTRY_RELEASE__.trim()) {
      return __SENTRY_RELEASE__.trim();
    }
  } catch {
    // ReferenceError in environments where the symbol was never defined (tests,
    // dev server without the production define).
  }
  return 'unknown';
}

export function initSentry(dsn?: string | null): void {
  const resolvedDsn = (dsn ?? '').trim();
  if (!resolvedDsn) return;

  Sentry.init({
    dsn: resolvedDsn,
    // Issue #543 / #971: Tag every error event with the exact build that
    // produced it. The Sentry CLI upload step in CI uploads source maps under
    // this same release identifier so stack traces resolve to original
    // TypeScript lines.
    release: resolveRelease(),
    integrations: [],
    tracesSampleRate: 0,
    enabled: true,
  });
}

/**
 * Exposed for testing — allows specs to verify the resolved release string
 * without initialising Sentry.
 */
export { resolveRelease };
