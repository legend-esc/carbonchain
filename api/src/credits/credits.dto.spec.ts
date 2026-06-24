import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { IssueCreditDto } from './dto/issue-credit.dto';

const validPayload = {
  issuerPublicKey: 'GABC123',
  projectId: 'PROJ-001',
  vintageYear: 2024,
  methodology: 'VCS',
  geography: 'NG',
  tonnes: '1000000',
  ipfsHash: 'bafybei123',
};

describe('IssueCreditDto', () => {
  it('passes with valid data', async () => {
    const dto = plainToInstance(IssueCreditDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing issuerPublicKey', async () => {
    const dto = plainToInstance(IssueCreditDto, {
      ...validPayload,
      issuerPublicKey: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'issuerPublicKey')).toBe(true);
  });

  it('rejects non-integer vintageYear', async () => {
    const dto = plainToInstance(IssueCreditDto, {
      ...validPayload,
      vintageYear: 'bad',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'vintageYear')).toBe(true);
  });

  it('rejects vintageYear below 1990', async () => {
    const dto = plainToInstance(IssueCreditDto, {
      ...validPayload,
      vintageYear: 1980,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'vintageYear')).toBe(true);
  });

  it('rejects non-numeric tonnes', async () => {
    const dto = plainToInstance(IssueCreditDto, {
      ...validPayload,
      tonnes: 'abc',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'tonnes')).toBe(true);
  });

  it('rejects missing ipfsHash', async () => {
    const dto = plainToInstance(IssueCreditDto, {
      ...validPayload,
      ipfsHash: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ipfsHash')).toBe(true);
  });
});
