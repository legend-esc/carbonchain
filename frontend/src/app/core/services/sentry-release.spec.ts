/**
 * Issue #971 — Assert that the runtime Sentry release equals the value
 * embedded in the bundle at build time.
 *
 * These unit tests verify:
 *  1. `resolveRelease()` returns the `__SENTRY_RELEASE__` constant when it is
 *     defined and non-empty (the production-build code path).
 *  2. `resolveRelease()` falls back to `'unknown'` when the constant is
 *     undefined or empty (local dev / test environment).
 *  3. `initSentry()` is a no-op when no DSN is provided (prevents accidental
 *     Sentry initialisation in test environments).
 *
 * The CI `Assert runtime release matches computed RELEASE` step performs the
 * complementary check at the bundle level: it greps the compiled JS for the
 * exact release string and fails the build if it is absent.
 */

import * as SentryBrowser from '@sentry/browser';
import { resolveRelease, initSentry } from './sentry-config';

// `__SENTRY_RELEASE__` is replaced by the Vite define at build time.  In the
// test environment the symbol is not defined, so `resolveRelease()` should fall
// back to 'unknown'.  We manually define the global for the "happy path" tests.

declare const globalThis: Record<string, unknown>;

describe('resolveRelease (sentry-config)', () => {
  it('returns "unknown" when __SENTRY_RELEASE__ is not defined (test / dev environment)', () => {
    // The symbol should not be defined in the Vitest/Karma environment.
    expect(resolveRelease()).toBe('unknown');
  });

  it('returns "unknown" when __SENTRY_RELEASE__ is an empty string', () => {
    // Temporarily shadow the constant via Object.defineProperty on globalThis.
    try {
      Object.defineProperty(globalThis, '__SENTRY_RELEASE__', {
        value: '   ',
        writable: true,
        configurable: true,
      });
      expect(resolveRelease()).toBe('unknown');
    } finally {
      // Restore: delete so subsequent tests see the original undefined state.
      delete (globalThis as Record<string, unknown>)['__SENTRY_RELEASE__'];
    }
  });

  it('returns the injected release string when __SENTRY_RELEASE__ is set', () => {
    const expected = '1.2.3+abc1234';
    try {
      Object.defineProperty(globalThis, '__SENTRY_RELEASE__', {
        value: expected,
        writable: true,
        configurable: true,
      });
      expect(resolveRelease()).toBe(expected);
    } finally {
      delete (globalThis as Record<string, unknown>)['__SENTRY_RELEASE__'];
    }
  });

  it('trims whitespace around the release string', () => {
    try {
      Object.defineProperty(globalThis, '__SENTRY_RELEASE__', {
        value: '  1.0.0+aabbcc  ',
        writable: true,
        configurable: true,
      });
      expect(resolveRelease()).toBe('1.0.0+aabbcc');
    } finally {
      delete (globalThis as Record<string, unknown>)['__SENTRY_RELEASE__'];
    }
  });
});

describe('initSentry', () => {
  let sentryInitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sentryInitSpy = vi.spyOn(SentryBrowser, 'init').mockImplementation(() => undefined);
  });

  afterEach(() => {
    sentryInitSpy.mockRestore();
  });

  it('does not call Sentry.init when no DSN is provided', () => {
    initSentry(undefined);
    expect(sentryInitSpy).not.toHaveBeenCalled();
  });

  it('does not call Sentry.init when DSN is an empty string', () => {
    initSentry('');
    initSentry('   ');
    expect(sentryInitSpy).not.toHaveBeenCalled();
  });

  it('calls Sentry.init with the DSN and the resolved release when a DSN is provided', () => {
    const dsn = 'https://abc123@sentry.io/12345';
    const release = '1.0.0+a1b2c3d';
    try {
      Object.defineProperty(globalThis, '__SENTRY_RELEASE__', {
        value: release,
        writable: true,
        configurable: true,
      });
      initSentry(dsn);
      expect(sentryInitSpy).toHaveBeenCalledOnce();
      expect(sentryInitSpy).toHaveBeenCalledWith(expect.objectContaining({ dsn, release }));
    } finally {
      delete (globalThis as Record<string, unknown>)['__SENTRY_RELEASE__'];
    }
  });

  it('uses "unknown" as the release when the bundle constant is missing', () => {
    const dsn = 'https://abc123@sentry.io/99999';
    initSentry(dsn);
    expect(sentryInitSpy).toHaveBeenCalledWith(expect.objectContaining({ release: 'unknown' }));
  });
});
