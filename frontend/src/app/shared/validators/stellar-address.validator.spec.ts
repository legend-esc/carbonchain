import { FormControl } from '@angular/forms';
import { isValidStellarPublicKey, stellarAddressValidator } from './stellar-address.validator';

describe('stellarAddressValidator', () => {
  // Well-known valid testnet-style public key (checksum-valid).
  const VALID_ADDRESS = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

  it('accepts a valid Stellar public key', () => {
    expect(isValidStellarPublicKey(VALID_ADDRESS)).toBe(true);
  });

  it('rejects garbage input like "abc123"', () => {
    expect(isValidStellarPublicKey('abc123')).toBe(false);
  });

  it('rejects addresses not starting with G', () => {
    const mutated = 'S' + VALID_ADDRESS.slice(1);
    expect(isValidStellarPublicKey(mutated)).toBe(false);
  });

  it('rejects addresses with a corrupted checksum', () => {
    const mutated = VALID_ADDRESS.slice(0, -1) + (VALID_ADDRESS.at(-1) === 'A' ? 'B' : 'A');
    expect(isValidStellarPublicKey(mutated)).toBe(false);
  });

  it('rejects wrong-length strings', () => {
    expect(isValidStellarPublicKey('GSHORT')).toBe(false);
  });

  it('returns a validation error for an invalid control value', () => {
    const control = new FormControl('abc123');
    expect(stellarAddressValidator()(control)).toEqual({
      stellarAddress: true,
    });
  });

  it('returns null for a valid control value', () => {
    const control = new FormControl(VALID_ADDRESS);
    expect(stellarAddressValidator()(control)).toBeNull();
  });

  it('returns null for an empty value (defers to required validator)', () => {
    const control = new FormControl('');
    expect(stellarAddressValidator()(control)).toBeNull();
  });
});
