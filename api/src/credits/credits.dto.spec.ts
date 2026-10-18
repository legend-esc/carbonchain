import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { IssueCreditDto } from './dto/issue-credit.dto';
import { TransferCreditDto } from './dto/transfer-credit.dto';
import { SplitCreditDto } from './dto/split-credit.dto';
import { MergeCreditsDto } from './dto/merge-credits.dto';
import { DisputeCreditDto } from './dto/dispute-credit.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { ExpireCreditDto } from './dto/expire-credit.dto';
import { BulkCreditsDto } from './dto/bulk-credits.dto';

const validPayload = {
  issuerPublicKey: 'GABC123',
  projectId: 'PROJ-001',
  vintageYear: 2024,
  methodology: 'VCS',
  geography: 'NG',
  tonnes: '1000000',
  ipfsHash: 'bafybei123',
  nonce: '1',
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

  it('rejects missing nonce', async () => {
    const dto = plainToInstance(IssueCreditDto, {
      ...validPayload,
      nonce: undefined,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'nonce')).toBe(true);
  });
});

describe('TransferCreditDto', () => {
  const validPayload = {
    to: 'GABC123...XYZ',
    nonce: 1,
  };

  it('passes with valid data', async () => {
    const dto = plainToInstance(TransferCreditDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty recipient', async () => {
    const dto = plainToInstance(TransferCreditDto, { ...validPayload, to: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'to')).toBe(true);
  });

  it('rejects missing nonce', async () => {
    const dto = plainToInstance(TransferCreditDto, {
      ...validPayload,
      nonce: undefined,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'nonce')).toBe(true);
  });
});

describe('SplitCreditDto', () => {
  const validPayload = {
    splitTonnes: '50000000',
    nonce: 1,
  };

  it('passes with valid data', async () => {
    const dto = plainToInstance(SplitCreditDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty splitTonnes', async () => {
    const dto = plainToInstance(SplitCreditDto, {
      ...validPayload,
      splitTonnes: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'splitTonnes')).toBe(true);
  });

  it('rejects missing nonce', async () => {
    const dto = plainToInstance(SplitCreditDto, {
      ...validPayload,
      nonce: undefined,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'nonce')).toBe(true);
  });
});

describe('MergeCreditsDto', () => {
  const validPayload = {
    callerPublicKey: 'GABC123',
    creditIds: ['a1b2c3d4', 'e5f6a7b8'],
    nonce: 1,
  };

  it('passes with valid data', async () => {
    const dto = plainToInstance(MergeCreditsDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing callerPublicKey', async () => {
    const dto = plainToInstance(MergeCreditsDto, {
      ...validPayload,
      callerPublicKey: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'callerPublicKey')).toBe(true);
  });

  it('rejects fewer than 2 creditIds', async () => {
    const dto = plainToInstance(MergeCreditsDto, {
      ...validPayload,
      creditIds: ['a1b2c3d4'],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'creditIds')).toBe(true);
  });

  it('rejects more than 20 creditIds', async () => {
    const dto = plainToInstance(MergeCreditsDto, {
      ...validPayload,
      creditIds: Array.from({ length: 21 }, (_, i) => `id-${i}`),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'creditIds')).toBe(true);
  });

  it('rejects an empty string inside creditIds', async () => {
    const dto = plainToInstance(MergeCreditsDto, {
      ...validPayload,
      creditIds: ['a1b2c3d4', ''],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'creditIds')).toBe(true);
  });

  it('rejects missing nonce', async () => {
    const dto = plainToInstance(MergeCreditsDto, {
      ...validPayload,
      nonce: undefined,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'nonce')).toBe(true);
  });
});

describe('DisputeCreditDto', () => {
  const validPayload = {
    disputerPublicKey: 'GABC123',
    evidenceIpfsHash: 'bafybei123',
  };

  it('passes with valid data', async () => {
    const dto = plainToInstance(DisputeCreditDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing disputerPublicKey', async () => {
    const dto = plainToInstance(DisputeCreditDto, {
      ...validPayload,
      disputerPublicKey: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'disputerPublicKey')).toBe(true);
  });

  it('rejects missing evidenceIpfsHash', async () => {
    const dto = plainToInstance(DisputeCreditDto, {
      ...validPayload,
      evidenceIpfsHash: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'evidenceIpfsHash')).toBe(true);
  });
});

describe('ResolveDisputeDto', () => {
  const validPayload = {
    adminPublicKey: 'GABC123',
    outcome: 0,
  };

  it('passes with valid data', async () => {
    const dto = plainToInstance(ResolveDisputeDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing adminPublicKey', async () => {
    const dto = plainToInstance(ResolveDisputeDto, {
      ...validPayload,
      adminPublicKey: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'adminPublicKey')).toBe(true);
  });

  it('rejects outcome below 0', async () => {
    const dto = plainToInstance(ResolveDisputeDto, {
      ...validPayload,
      outcome: -1,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'outcome')).toBe(true);
  });

  it('rejects outcome above 2', async () => {
    const dto = plainToInstance(ResolveDisputeDto, {
      ...validPayload,
      outcome: 3,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'outcome')).toBe(true);
  });

  it('rejects non-integer outcome', async () => {
    const dto = plainToInstance(ResolveDisputeDto, {
      ...validPayload,
      outcome: 1.5,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'outcome')).toBe(true);
  });
});

describe('ExpireCreditDto', () => {
  const validPayload = {
    adminPublicKey: 'GABC123',
  };

  it('passes with valid data', async () => {
    const dto = plainToInstance(ExpireCreditDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing adminPublicKey', async () => {
    const dto = plainToInstance(ExpireCreditDto, {
      ...validPayload,
      adminPublicKey: '',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'adminPublicKey')).toBe(true);
  });
});

describe('BulkCreditsDto', () => {
  const VALID_64 = 'a'.repeat(64);
  const validPayload = {
    ids: [VALID_64, 'b'.repeat(64)],
  };

  it('passes with valid 64-char hex IDs', async () => {
    const dto = plainToInstance(BulkCreditsDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an empty ids array', async () => {
    const dto = plainToInstance(BulkCreditsDto, { ids: [] });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ids')).toBe(true);
  });

  it('rejects more than 100 ids', async () => {
    const dto = plainToInstance(BulkCreditsDto, {
      ids: Array.from({ length: 101 }, () => VALID_64),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ids')).toBe(true);
  });

  it('rejects a malformed (non-hex) id', async () => {
    const dto = plainToInstance(BulkCreditsDto, {
      ids: [VALID_64, 'NOT_HEX_' + 'z'.repeat(57)],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ids')).toBe(true);
  });

  it('rejects an id that is not 64 characters', async () => {
    const dto = plainToInstance(BulkCreditsDto, { ids: ['abc123'] });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ids')).toBe(true);
  });

  it('rejects a non-string element', async () => {
    const dto = plainToInstance(BulkCreditsDto, { ids: [123, VALID_64] });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'ids')).toBe(true);
  });
});
