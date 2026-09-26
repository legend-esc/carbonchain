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
});
