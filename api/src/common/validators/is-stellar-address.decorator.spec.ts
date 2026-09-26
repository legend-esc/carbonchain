import { IsStellarAddressConstraint } from './is-stellar-address.decorator';
import { Keypair } from '@stellar/stellar-sdk';

describe('IsStellarAddressConstraint', () => {
  const constraint = new IsStellarAddressConstraint();

  it('accepts a valid Stellar ed25519 public key', () => {
    expect(constraint.validate(Keypair.random().publicKey())).toBe(true);
  });

  it('rejects non-string values', () => {
    expect(constraint.validate(123)).toBe(false);
    expect(constraint.validate(null)).toBe(false);
    expect(constraint.validate(undefined)).toBe(false);
  });

  it('rejects malformed address strings', () => {
    expect(constraint.validate('not-a-stellar-key')).toBe(false);
    expect(constraint.validate('GABC')).toBe(false);
    expect(constraint.validate('')).toBe(false);
  });

  it('provides a default error message', () => {
    expect(constraint.defaultMessage()).toContain('Invalid Stellar');
  });
});
