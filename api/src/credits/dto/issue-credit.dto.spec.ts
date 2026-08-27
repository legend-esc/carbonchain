import { validate } from 'class-validator';
import { Keypair } from '@stellar/stellar-sdk';
import { IssueCreditDto } from './issue-credit.dto';

describe('IssueCreditDto', () => {
  it('accepts valid Stellar and IPFS inputs', async () => {
    const dto = Object.assign(new IssueCreditDto(), {
      issuerPublicKey: Keypair.random().publicKey(),
      projectId: 'project-1',
      vintageYear: 2025,
      methodology: 'Custom-forest-restoration',
      geography: 'NG',
      tonnes: '10',
      ipfsHash: 'bafybeigdyrzt5a6u7s6q4x5z6c7v2b7n2m2k2j2h4g5f6d7s7a2',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects malformed Stellar and IPFS inputs', async () => {
    const dto = Object.assign(new IssueCreditDto(), {
      issuerPublicKey: 'not-a-stellar-address',
      projectId: 'project-1',
      vintageYear: 2025,
      methodology: 'Custom-forest-restoration',
      geography: 'NG',
      tonnes: '10',
      ipfsHash: 'not-a-cid',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['issuerPublicKey', 'ipfsHash']),
    );
  });
});