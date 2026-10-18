import type { AxeResults, Result } from 'axe-core';

/**
 * Impact levels defined by axe-core for accessibility rule violations.
 */
export type A11yImpact = 'critical' | 'serious' | 'moderate' | 'minor';

/**
 * Configuration options for accessibility gate thresholds.
 */
export interface A11yThresholdConfig {
  /** Maximum allowed violation counts per severity level (default: 0 critical, 0 serious) */
  allowedViolations: Record<A11yImpact, number>;
  /** Minimum passing score percentage (0-100) based on evaluated rules */
  minimumScore: number;
}

/**
 * Default strict accessibility threshold configuration:
 * Enforces zero critical and zero serious violations (WCAG 2.1 AA requirement).
 */
export const DEFAULT_A11Y_THRESHOLD: A11yThresholdConfig = {
  allowedViolations: {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: Number.POSITIVE_INFINITY,
  },
  minimumScore: 90,
};

/**
 * Evaluation report containing violation counts, computed score, and pass/fail status.
 */
export interface A11yThresholdReport {
  passed: boolean;
  score: number;
  violationsByImpact: Record<A11yImpact, Result[]>;
  blockingViolations: Result[];
  failureReasons: string[];
}

/**
 * Evaluates axe results against an accessibility threshold configuration.
 */
export function evaluateA11yThreshold(
  results: AxeResults,
  customThreshold?: Partial<A11yThresholdConfig>,
): A11yThresholdReport {
  const threshold: A11yThresholdConfig = {
    allowedViolations: {
      ...DEFAULT_A11Y_THRESHOLD.allowedViolations,
      ...(customThreshold?.allowedViolations ?? {}),
    },
    minimumScore: customThreshold?.minimumScore ?? DEFAULT_A11Y_THRESHOLD.minimumScore,
  };

  const violationsByImpact: Record<A11yImpact, Result[]> = {
    critical: [],
    serious: [],
    moderate: [],
    minor: [],
  };

  for (const violation of results.violations) {
    const impact = (violation.impact as A11yImpact) || 'minor';
    if (violationsByImpact[impact]) {
      violationsByImpact[impact].push(violation);
    }
  }

  const failureReasons: string[] = [];
  const blockingViolations: Result[] = [];

  for (const impact of ['critical', 'serious', 'moderate', 'minor'] as const) {
    const count = violationsByImpact[impact].length;
    const maxAllowed = threshold.allowedViolations[impact];
    if (count > maxAllowed) {
      failureReasons.push(
        `Exceeded ${impact} violations threshold: found ${count}, max allowed is ${maxAllowed}.`,
      );
      blockingViolations.push(...violationsByImpact[impact]);
    }
  }

  // Compute compliance score based on passing rules vs total evaluated rules
  const totalRules = results.passes.length + results.violations.length;
  const score = totalRules > 0 ? Math.round((results.passes.length / totalRules) * 100) : 100;

  if (score < threshold.minimumScore) {
    failureReasons.push(
      `Accessibility score ${score}% is below minimum threshold of ${threshold.minimumScore}%.`,
    );
  }

  return {
    passed: failureReasons.length === 0,
    score,
    violationsByImpact,
    blockingViolations,
    failureReasons,
  };
}

/**
 * Asserts that axe results satisfy the minimum score threshold and zero critical/serious violations.
 * Throws an Error with detailed violation summaries if the assertion fails.
 */
export function assertA11yThreshold(
  results: AxeResults,
  customThreshold?: Partial<A11yThresholdConfig>,
): void {
  const report = evaluateA11yThreshold(results, customThreshold);
  if (!report.passed) {
    const details = report.blockingViolations
      .map((v) => `  - [${v.impact?.toUpperCase()}] ${v.id}: ${v.help} (${v.nodes.length} element(s))`)
      .join('\n');

    throw new Error(
      `Accessibility threshold failed (Score: ${report.score}%):\n${report.failureReasons.join(
        '\n',
      )}\n\nViolations:\n${details}`,
    );
  }
}
