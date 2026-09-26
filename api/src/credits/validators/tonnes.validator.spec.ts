/**
 * #414 — Tonnes validator boundary tests
 *
 * Covers the exact boundary values specified in the issue:
 *   99_999  → rejected  (not a multiple of 100_000)
 *   100_000 → accepted  (minimum valid value)
 *   100_001 → rejected  (not a multiple of 100_000)
 *   0       → rejected  (not positive)
 *   -100_000 → rejected (not positive)
 *
 * Also exercises the IsTonnesMultipleConstraint directly so the logic is
 * tested independently from the DTO class-validator wiring.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { IssueCreditDto } from '../dto/issue-credit.dto';
import { IsTonnesMultipleConstraint } from './tonnes.validator';

// ── Direct constraint unit tests ──────────────────────────────────────────────

describe('IsTonnesMultipleConstraint (unit)', () => {
  let constraint: IsTonnesMultipleConstraint;

  beforeEach(() => {
    constraint = new IsTonnesMultipleConstraint();
  });

  it('rejects 99_999 — one below the minimum unit', () => {
    expect(constraint.validate('99999')).toBe(false);
  });

  it('accepts 100_000 — the minimum valid value', () => {
    expect(constraint.validate('100000')).toBe(true);
  });

  it('rejects 100_001 — one above the minimum unit', () => {
    expect(constraint.validate('100001')).toBe(false);
  });

  it('rejects 0 — zero is not a positive multiple', () => {
    expect(constraint.validate('0')).toBe(false);
  });

  it('rejects -100_000 — negative value', () => {
    expect(constraint.validate('-100000')).toBe(false);
  });

  // Additional boundary and sanity checks
  it('accepts 1_000_000 — exactly 1 tonne', () => {
    expect(constraint.validate('1000000')).toBe(true);
  });

  it('accepts 500_000 — 0.5 tonne', () => {
    expect(constraint.validate('500000')).toBe(true);
  });

  it('accepts 200_000 — 0.2 tonne', () => {
    expect(constraint.validate('200000')).toBe(true);
  });

  it('rejects 50_000 — below minimum unit', () => {
    expect(constraint.validate('50000')).toBe(false);
  });

  it('rejects 1 — well below minimum unit', () => {
    expect(constraint.validate('1')).toBe(false);
  });

  it('rejects non-numeric string', () => {
    expect(constraint.validate('abc')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(constraint.validate('')).toBe(false);
  });

  it('rejects non-string number (type guard)', () => {
    expect(constraint.validate(100000 as any)).toBe(false);
  });

  it('has correct default message', () => {
    expect(constraint.defaultMessage()).toContain('100000');
  });
});

// ── DTO-level integration: class-validator wiring ─────────────────────────────

const BASE = {
  issuerPublicKey: 'GABC123',
  projectId: 'PROJ-001',
  vintageYear: 2024,
  methodology: 'VCS',
  geography: 'NG',
  ipfsHash: 'bafybei123',
};

async function tonnesErrors(tonnes: string) {
  const dto = plainToInstance(IssueCreditDto, { ...BASE, tonnes });
  const errors = await validate(dto);
  return errors.filter((e) => e.property === 'tonnes');
}

describe('IssueCreditDto tonnes boundary validation (issue #414)', () => {
  it('rejects 99_999 with 400-equivalent validation error', async () => {
    const errs = await tonnesErrors('99999');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].constraints?.isTonnesMultiple).toContain('100,000');
  });

  it('accepts 100_000 — minimum valid unit', async () => {
    const errs = await tonnesErrors('100000');
    expect(errs).toHaveLength(0);
  });

  it('rejects 100_001 with 400-equivalent validation error', async () => {
    const errs = await tonnesErrors('100001');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].constraints?.isTonnesMultiple).toContain('100,000');
  });

  it('rejects 0 with 400-equivalent validation error', async () => {
    const errs = await tonnesErrors('0');
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects -100_000 with 400-equivalent validation error', async () => {
    const errs = await tonnesErrors('-100000');
    expect(errs.length).toBeGreaterThan(0);
  });
});
