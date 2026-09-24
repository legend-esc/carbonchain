/**
 * Lighthouse CI configuration — Issue #549
 *
 * Runs accessibility audits on every PR and fails if the accessibility score
 * drops below 90. Zero critical axe violations are enforced via assertions.
 *
 * Triggered by .github/workflows/ci.yml (frontend job, lighthouse step).
 *
 * Reference: https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md
 */

/** @type {import('@lhci/cli').LhciConfig} */
module.exports = {
  ci: {
    collect: {
      // Static dist output — no server needed in CI.
      // The "frontend" job builds the app first (`ng build`), then LHCI
      // serves the dist directory with its built-in static server.
      staticDistDir: './dist/frontend/browser',

      // Pages to audit. Add more routes as the app grows.
      url: [
        'http://localhost/index.html',            // shell / root
        'http://localhost/marketplace',           // marketplace listing
        'http://localhost/retire',               // retirement wizard
        'http://localhost/certificates',         // certificate viewer
      ],

      numberOfRuns: 3,
    },

    assert: {
      preset: 'lighthouse:no-pwa',

      assertions: {
        // ── CI gate: accessibility score ≥ 90 ─────────────────────────────
        'categories:accessibility': ['error', { minScore: 0.9 }],

        // ── Performance — warn only (informational baseline) ───────────────
        'categories:performance': ['warn', { minScore: 0.5 }],

        // ── Specific accessibility rules (zero critical violations) ────────
        // Buttons must have discernible text
        'button-name': 'error',
        // Images must have alt text
        'image-alt': 'error',
        // Interactive elements must be keyboard-focusable
        'interactive-element-affordance': 'error',
        // Labels must be associated with form elements
        'label': 'error',
        // Links must have discernible text
        'link-name': 'error',
        // Document must have a lang attribute
        'html-has-lang': 'error',
        // Heading order must not skip levels
        'heading-order': 'warn',
        // Color contrast must meet WCAG AA (4.5:1 for normal text)
        'color-contrast': 'error',
        // Tables must have captions or aria-label
        'table-duplicate-name': 'warn',
        // ARIA roles must be valid
        'aria-allowed-attr': 'error',
        'aria-required-attr': 'error',
        'aria-valid-attr': 'error',
        'aria-valid-attr-value': 'error',
      },
    },

    upload: {
      // Upload to temporary public LHCI storage in CI.
      // For persistent history, replace with a private LHCI server URL and
      // set LHCI_TOKEN in GitHub Actions secrets.
      target: 'temporary-public-storage',
    },
  },
};
