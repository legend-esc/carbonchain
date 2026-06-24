import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { OracleService, MrvWebhookDto } from './oracle.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';

const mockStellarService = { invokeContract: jest.fn() };
const mockKeypairService = {
  getAdminKeypair: jest.fn().mockReturnValue({ publicKey: () => 'GADMIN' }),
};
const mockConfigService = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'MRV_ORACLE_CONTRACT_ID') return 'CORACLE';
    if (key === 'ORACLE_WEBHOOK_SECRET') return 'testsecret';
    return def;
  }),
};

function makeSignature(
  projectId: string,
  tonnes: string,
  secret = 'testsecret',
): string {
  return createHmac('sha256', secret)
    .update(`${projectId}:${tonnes}`)
    .digest('hex');
}

// Valid Stellar G-address (56 chars, base32)
const VALID_ORACLE_KEY =
  'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';

describe('OracleService', () => {
  let service: OracleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: StellarKeypairService, useValue: mockKeypairService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<OracleService>(OracleService);
    jest.clearAllMocks();
  });

  it('rejects invalid signature', async () => {
    const dto: MrvWebhookDto = {
      oraclePublicKey: VALID_ORACLE_KEY,
      projectId: 'PROJ-001',
      tonnesSequestered: '1000000',
      signature: 'badhex',
    };
    await expect(service.ingestMrvData(dto)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('forwards valid data to contract and returns anomaly flag', async () => {
    mockStellarService.invokeContract.mockResolvedValue({ returnValue: null });
    const dto: MrvWebhookDto = {
      oraclePublicKey: VALID_ORACLE_KEY,
      projectId: 'PROJ-001',
      tonnesSequestered: '1000000',
      signature: makeSignature('PROJ-001', '1000000'),
    };
    const result = await service.ingestMrvData(dto);
    expect(mockStellarService.invokeContract).toHaveBeenCalledWith(
      'CORACLE',
      'update_mrv_data',
      expect.any(Array),
      expect.anything(),
    );
    expect(result).toEqual({ anomaly: false });
  });
});
