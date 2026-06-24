import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RetireDto } from './dto/retire.dto';

const validPayload = {
  buyerPublicKey: 'GABC123',
  creditId: '037176a1',
  tonnes: '1000000',
  reason: '2024 Scope 3 offset',
};

describe('RetireDto', () => {
  it('passes with valid data', async () => {
    const dto = plainToInstance(RetireDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty buyerPublicKey', async () => {
    const dto = plainToInstance(RetireDto, {
      ...validPayload,
      buyerPublicKey: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'buyerPublicKey')).toBe(true);
  });

  it('rejects empty creditId', async () => {
    const dto = plainToInstance(RetireDto, { ...validPayload, creditId: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'creditId')).toBe(true);
  });

  it('rejects non-numeric tonnes', async () => {
    const dto = plainToInstance(RetireDto, {
      ...validPayload,
      tonnes: 'not-a-number',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'tonnes')).toBe(true);
  });

  it('rejects empty reason', async () => {
    const dto = plainToInstance(RetireDto, { ...validPayload, reason: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });
});
