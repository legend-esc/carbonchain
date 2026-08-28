import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateOfferDto } from './dto/create-offer.dto';

const validPayload = {
  sellerPublicKey: 'GABC123',
  creditId: '037176a1',
  priceXlm: '10000000',
  tonnes: '1000000',
};

describe('CreateOfferDto', () => {
  it('passes with valid data', async () => {
    const dto = plainToInstance(CreateOfferDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty sellerPublicKey', async () => {
    const dto = plainToInstance(CreateOfferDto, {
      ...validPayload,
      sellerPublicKey: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'sellerPublicKey')).toBe(true);
  });

  it('rejects non-numeric priceXlm', async () => {
    const dto = plainToInstance(CreateOfferDto, {
      ...validPayload,
      priceXlm: 'free',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'priceXlm')).toBe(true);
  });

  it('rejects non-numeric tonnes', async () => {
    const dto = plainToInstance(CreateOfferDto, {
      ...validPayload,
      tonnes: 'lots',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'tonnes')).toBe(true);
  });
});
