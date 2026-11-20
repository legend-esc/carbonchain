/**
 * #1097 — Geography validator unit tests
 *
 * Covers ISO 3166-1 alpha-2 validation for the `geography` field in IssueCreditDto.
 *
 * Valid codes: US, NG, BR, CN, DE, JP, GB, FR, AU, IN
 * Invalid codes: XX, USA, 123, NIG, '' (empty), 'us' (lowercase), '  ' (whitespace)
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { IssueCreditDto } from '../dto/issue-credit.dto';
import { IsValidGeographyConstraint } from './geography.validator';

// ── Direct constraint unit tests ──────────────────────────────────────────────

describe('IsValidGeographyConstraint (unit)', () => {
  let constraint: IsValidGeographyConstraint;

  beforeEach(() => {
    constraint = new IsValidGeographyConstraint();
  });

  // ── Valid codes ───────────────────────────────────────────────────────────

  it('accepts US — United States', () => {
    expect(constraint.validate('US')).toBe(true);
  });

  it('accepts NG — Nigeria', () => {
    expect(constraint.validate('NG')).toBe(true);
  });

  it('accepts BR — Brazil', () => {
    expect(constraint.validate('BR')).toBe(true);
  });

  it('accepts CN — China', () => {
    expect(constraint.validate('CN')).toBe(true);
  });

  it('accepts DE — Germany', () => {
    expect(constraint.validate('DE')).toBe(true);
  });

  it('accepts JP — Japan', () => {
    expect(constraint.validate('JP')).toBe(true);
  });

  it('accepts GB — United Kingdom', () => {
    expect(constraint.validate('GB')).toBe(true);
  });

  it('accepts FR — France', () => {
    expect(constraint.validate('FR')).toBe(true);
  });

  it('accepts AU — Australia', () => {
    expect(constraint.validate('AU')).toBe(true);
  });

  it('accepts IN — India', () => {
    expect(constraint.validate('IN')).toBe(true);
  });

  // ── Invalid codes ─────────────────────────────────────────────────────────

  it('rejects XX — not a valid ISO code', () => {
    expect(constraint.validate('XX')).toBe(false);
  });

  it('rejects USA — three-letter code', () => {
    expect(constraint.validate('USA')).toBe(false);
  });

  it('rejects 123 — numeric string', () => {
    expect(constraint.validate('123')).toBe(false);
  });

  it('rejects NIG — invalid alpha-3-like code', () => {
    expect(constraint.validate('NIG')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(constraint.validate('')).toBe(false);
  });

  it('rejects lowercase us — must be uppercase', () => {
    expect(constraint.validate('us')).toBe(false);
  });

  it('rejects whitespace string', () => {
    expect(constraint.validate('  ')).toBe(false);
  });

  it('rejects non-string number (type guard)', () => {
    expect(constraint.validate(42 as any)).toBe(false);
  });

  it('has correct default error message', () => {
    expect(constraint.defaultMessage()).toBe(
      'geography must be a valid ISO 3166-1 alpha-2 country code',
    );
  });
});

// ── DTO-level integration: class-validator wiring ─────────────────────────────

const BASE = {
  issuerPublicKey: 'GABC123',
  projectId: 'PROJ-001',
  vintageYear: 2024,
  methodology: 'VCS',
  tonnes: '1000000',
  ipfsHash: 'bafybei123',
};

async function geographyErrors(geography: string) {
  const dto = plainToInstance(IssueCreditDto, { ...BASE, geography });
  const errors = await validate(dto);
  return errors.filter((e) => e.property === 'geography');
}

describe('IssueCreditDto geography validation (issue #1097)', () => {
  it('accepts NG — valid ISO code', async () => {
    const errs = await geographyErrors('NG');
    expect(errs).toHaveLength(0);
  });

  it('accepts US — valid ISO code', async () => {
    const errs = await geographyErrors('US');
    expect(errs).toHaveLength(0);
  });

  it('accepts BR — valid ISO code', async () => {
    const errs = await geographyErrors('BR');
    expect(errs).toHaveLength(0);
  });

  it('rejects XX — unknown code', async () => {
    const errs = await geographyErrors('XX');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].constraints?.isValidGeography).toContain(
      'ISO 3166-1 alpha-2',
    );
  });

  it('rejects USA — three-letter code', async () => {
    const errs = await geographyErrors('USA');
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects 123 — numeric string', async () => {
    const errs = await geographyErrors('123');
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects NIG — invalid format', async () => {
    const errs = await geographyErrors('NIG');
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects lowercase us — case-sensitive', async () => {
    const errs = await geographyErrors('us');
    expect(errs.length).toBeGreaterThan(0);
  });
});
