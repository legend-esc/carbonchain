/**
 * #937 — Unit and property tests for number-conversions.ts
 *
 * Covers:
 *  • stroopsToXlm fixed examples
 *  • xlmToStroops fixed examples
 *  • Round-trip property: xlmToStroops(stroopsToXlm(x)) === x
 *  • Edge cases: zero, 1 stroop, max safe integers, negative guards
 *  • BigInt-safety: values beyond Number.MAX_SAFE_INTEGER
 */
import {
  stroopsToXlm,
  xlmToStroops,
  STROOPS_PER_XLM,
} from './number-conversions';

describe('STROOPS_PER_XLM constant', () => {
  it('equals 10_000_000n', () => {
    expect(STROOPS_PER_XLM).toBe(10_000_000n);
  });
});

describe('stroopsToXlm', () => {
  it('converts 0 stroops to "0"', () => {
    expect(stroopsToXlm(0n)).toBe('0');
  });

  it('converts 1 stroop to "0.0000001"', () => {
    expect(stroopsToXlm(1n)).toBe('0.0000001');
  });

  it('converts 10_000_000 stroops to "1"', () => {
    expect(stroopsToXlm(10_000_000n)).toBe('1');
  });

  it('converts 25_000_000 stroops to "2.5"', () => {
    expect(stroopsToXlm(25_000_000n)).toBe('2.5');
  });

  it('converts 100 stroops to "0.00001"', () => {
    expect(stroopsToXlm(100n)).toBe('0.00001');
  });

  it('converts 10_000_001 stroops to "1.0000001"', () => {
    expect(stroopsToXlm(10_000_001n)).toBe('1.0000001');
  });

  it('strips trailing zeros from fractional part', () => {
    expect(stroopsToXlm(10_500_000n)).toBe('1.05');
  });

  it('accepts numeric string input', () => {
    expect(stroopsToXlm('20000000')).toBe('2');
  });

  it('accepts number input', () => {
    expect(stroopsToXlm(10_000_000)).toBe('1');
  });

  it('handles large BigInt values safely (beyond Number.MAX_SAFE_INTEGER)', () => {
    // 1_000_000_000 XLM = 10^16 stroops > Number.MAX_SAFE_INTEGER (~9×10^15)
    const largeStroops = 10_000_000_000_000_000n; // 1_000_000_000 XLM
    expect(stroopsToXlm(largeStroops)).toBe('1000000000');
  });

  it('throws RangeError for negative values', () => {
    expect(() => stroopsToXlm(-1n)).toThrow(RangeError);
  });
});

describe('xlmToStroops', () => {
  it('converts "0" to 0n', () => {
    expect(xlmToStroops('0')).toBe(0n);
  });

  it('converts "1" to 10_000_000n', () => {
    expect(xlmToStroops('1')).toBe(10_000_000n);
  });

  it('converts "2.5" to 25_000_000n', () => {
    expect(xlmToStroops('2.5')).toBe(25_000_000n);
  });

  it('converts "0.0000001" to 1n', () => {
    expect(xlmToStroops('0.0000001')).toBe(1n);
  });

  it('converts "1.05" to 10_500_000n', () => {
    expect(xlmToStroops('1.05')).toBe(10_500_000n);
  });

  it('pads fractional part — "1.1" becomes 11_000_000n', () => {
    expect(xlmToStroops('1.1')).toBe(11_000_000n);
  });

  it('truncates (not rounds) at 7 decimal places', () => {
    // 1.00000009 → truncate to 1.0000000 → 10_000_000n
    expect(xlmToStroops('1.00000009')).toBe(10_000_000n);
  });

  it('accepts number input', () => {
    expect(xlmToStroops(1)).toBe(10_000_000n);
  });

  it('handles large whole numbers safely (beyond Number.MAX_SAFE_INTEGER)', () => {
    expect(xlmToStroops('1000000000')).toBe(10_000_000_000_000_000n);
  });

  it('throws RangeError for negative values', () => {
    expect(() => xlmToStroops('-1')).toThrow(RangeError);
  });

  it('throws TypeError for non-numeric strings', () => {
    expect(() => xlmToStroops('abc')).toThrow(TypeError);
    expect(() => xlmToStroops('1e7')).toThrow(TypeError);
    expect(() => xlmToStroops('')).toThrow(TypeError);
  });
});

describe('round-trip property: xlmToStroops(stroopsToXlm(x)) === x', () => {
  const cases: bigint[] = [
    0n,
    1n,
    100n,
    10_000_000n,
    25_000_000n,
    99_999_999n,
    1_000_000_000_000n,
    10_000_000_000_000_000n,
  ];

  for (const stroops of cases) {
    it(`round-trips ${stroops} stroops`, () => {
      const xlm = stroopsToXlm(stroops);
      const back = xlmToStroops(xlm);
      expect(back).toBe(stroops);
    });
  }
});
