/**
 * axe-core accessibility configuration — Issue #549
 *
 * Used by component specs via @axe-core/browser to enforce zero critical/serious
 * violations across all Angular components.
 *
 * Usage in a Jasmine / Vitest spec:
 *
 *   import axe from 'axe-core';
 *   import { axeConfig } from '../../axe.config';
 *
 *   it('should have no accessibility violations', async () => {
 *     const results = await axe.run(document.body, axeConfig);
 *     const violations = results.violations.filter(
 *       (v) => v.impact === 'critical' || v.impact === 'serious',
 *     );
 *     expect(violations).toEqual([]);
 *   });
 *
 * Reference: https://www.deque.com/axe/core-documentation/api-documentation/#options-parameter
 */

/** @type {import('axe-core').RunOptions} */
export const axeConfig = {
  // WCAG 2.1 AA — the minimum legal standard in most jurisdictions.
  // Include 'wcag21aaa' if AAA compliance is required.
  runOnly: {
    type: 'tag',
    values: [
      'wcag2a',    // WCAG 2.0 Level A
      'wcag2aa',   // WCAG 2.0 Level AA
      'wcag21a',   // WCAG 2.1 Level A
      'wcag21aa',  // WCAG 2.1 Level AA
      'best-practice',
    ],
  },

  // Rules that are globally disabled because they generate false positives in
  // a Chromium-less JSDOM test environment. Disable sparingly and document why.
  rules: {
    // color-contrast requires a rendered viewport with computed styles.
    // axe in JSDOM cannot accurately measure contrast because JSDOM does not
    // compute CSS. Verify contrast manually or via Lighthouse CI instead.
    'color-contrast': { enabled: false },
  },
};

/**
 * Categorises axe violations by impact level for concise test output.
 *
 * @param {import('axe-core').Result[]} violations
 * @returns {{ critical: import('axe-core').Result[], serious: import('axe-core').Result[], moderate: import('axe-core').Result[], minor: import('axe-core').Result[] }}
 */
export function categoriseViolations(violations) {
  return {
    critical: violations.filter((v) => v.impact === 'critical'),
    serious: violations.filter((v) => v.impact === 'serious'),
    moderate: violations.filter((v) => v.impact === 'moderate'),
    minor: violations.filter((v) => v.impact === 'minor'),
  };
}
