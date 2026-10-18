import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RetireDto } from './dto/retire.dto';

describe('RetireDto', () => {
  it('passes with valid reason', async () => {
    const dto = plainToInstance(RetireDto, { reason: '2024 Scope 3 offset' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty reason', async () => {
    const dto = plainToInstance(RetireDto, { reason: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('rejects reason longer than 200 characters', async () => {
    const dto = plainToInstance(RetireDto, { reason: 'x'.repeat(201) });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('accepts reason at exactly 200 characters', async () => {
    const dto = plainToInstance(RetireDto, { reason: 'x'.repeat(200) });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // ── reason length boundary tests ─────────────────────────────────────────

  it('rejects reason with 0 characters (empty string)', async () => {
    const dto = plainToInstance(RetireDto, { ...validPayload, reason: '' });
    const errors = await validate(dto);
    const reasonErrors = errors.filter((e) => e.property === 'reason');
    expect(reasonErrors.length).toBeGreaterThan(0);
    const messages = reasonErrors.flatMap((e) =>
      Object.values(e.constraints ?? {}),
    );
    expect(messages.some((m) => m.includes('reason must be between 1 and 500 characters'))).toBe(true);
  });

  it('passes reason with exactly 1 character', async () => {
    const dto = plainToInstance(RetireDto, { ...validPayload, reason: 'x' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'reason')).toBe(false);
  });

  it('passes reason with exactly 500 characters', async () => {
    const dto = plainToInstance(RetireDto, {
      ...validPayload,
      reason: 'a'.repeat(500),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'reason')).toBe(false);
  });

  it('rejects reason with 501 characters', async () => {
    const dto = plainToInstance(RetireDto, {
      ...validPayload,
      reason: 'a'.repeat(501),
    });
    const errors = await validate(dto);
    const reasonErrors = errors.filter((e) => e.property === 'reason');
    expect(reasonErrors.length).toBeGreaterThan(0);
    const messages = reasonErrors.flatMap((e) =>
      Object.values(e.constraints ?? {}),
    );
    expect(messages.some((m) => m.includes('reason must be between 1 and 500 characters'))).toBe(true);
  });
});
