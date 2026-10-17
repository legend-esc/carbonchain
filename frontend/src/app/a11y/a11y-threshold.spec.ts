import type { AxeResults, Result } from 'axe-core';
import {
  evaluateA11yThreshold,
  assertA11yThreshold,
  DEFAULT_A11Y_THRESHOLD,
  type A11yThresholdConfig,
} from './a11y-threshold';

describe('a11y-threshold — score & violation rules', () => {
  function makeAxeResults(
    violations: Partial<Result>[],
    passesCount: number = 10,
  ): AxeResults {
    return {
      violations: violations as Result[],
      passes: Array.from({ length: passesCount }, (_, i) => ({ id: `pass-${i}` })) as never[],
      incomplete: [],
      inapplicable: [],
      toolOptions: {} as never,
      testEngine: { name: 'axe-core', version: '4.11.0' },
      testRunner: { name: 'axe' },
      testEnvironment: {} as never,
      url: 'http://localhost',
      timestamp: new Date().toISOString(),
    };
  }

  it('passes when there are zero violations and score exceeds 90%', () => {
    const results = makeAxeResults([], 10);
    const report = evaluateA11yThreshold(results);

    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
    expect(report.failureReasons.length).toBe(0);
    expect(report.blockingViolations.length).toBe(0);
    expect(() => assertA11yThreshold(results)).not.toThrow();
  });

  it('fails when a critical violation is present', () => {
    const results = makeAxeResults([
      {
        id: 'color-contrast',
        impact: 'critical',
        help: 'Elements must have sufficient color contrast',
        nodes: [{ html: '<button>Click</button>' }] as never,
      },
    ]);
    const report = evaluateA11yThreshold(results);

    expect(report.passed).toBe(false);
    expect(report.failureReasons).toContain(
      'Exceeded critical violations threshold: found 1, max allowed is 0.',
    );
    expect(report.blockingViolations.length).toBe(1);
    expect(() => assertA11yThreshold(results)).toThrow(/critical violations threshold/i);
  });

  it('fails when a serious violation is present', () => {
    const results = makeAxeResults([
      {
        id: 'button-name',
        impact: 'serious',
        help: 'Buttons must have discernible text',
        nodes: [{ html: '<button></button>' }] as never,
      },
    ]);
    const report = evaluateA11yThreshold(results);

    expect(report.passed).toBe(false);
    expect(report.failureReasons).toContain(
      'Exceeded serious violations threshold: found 1, max allowed is 0.',
    );
    expect(report.blockingViolations.length).toBe(1);
    expect(() => assertA11yThreshold(results)).toThrow(/serious violations threshold/i);
  });

  it('tolerates minor violations when allowedViolations.minor is Infinity', () => {
    const results = makeAxeResults(
      [
        {
          id: 'focus-order-semantics',
          impact: 'minor',
          help: 'Order of elements in tab order',
          nodes: [{ html: '<span>note</span>' }] as never,
        },
      ],
      19, // 19 passes + 1 minor = 95% score >= 90%
    );
    const report = evaluateA11yThreshold(results);

    expect(report.passed).toBe(true);
    expect(report.score).toBe(95);
    expect(report.violationsByImpact.minor.length).toBe(1);
    expect(() => assertA11yThreshold(results)).not.toThrow();
  });

  it('fails when accessibility score drops below the defined minimum threshold', () => {
    const customConfig: Partial<A11yThresholdConfig> = {
      allowedViolations: {
        critical: 5,
        serious: 5,
        moderate: 5,
        minor: 5,
      },
      minimumScore: 90,
    };

    // 5 violations out of 10 total = 50% score
    const results = makeAxeResults(
      [
        { id: 'v1', impact: 'minor', nodes: [] as never, help: 'h1' },
        { id: 'v2', impact: 'minor', nodes: [] as never, help: 'h2' },
        { id: 'v3', impact: 'minor', nodes: [] as never, help: 'h3' },
        { id: 'v4', impact: 'minor', nodes: [] as never, help: 'h4' },
        { id: 'v5', impact: 'minor', nodes: [] as never, help: 'h5' },
      ],
      5,
    );

    const report = evaluateA11yThreshold(results, customConfig);
    expect(report.passed).toBe(false);
    expect(report.score).toBe(50);
    expect(report.failureReasons[0]).toMatch(/below minimum threshold of 90%/i);
    expect(() => assertA11yThreshold(results, customConfig)).toThrow(
      /below minimum threshold of 90%/i,
    );
  });
});
