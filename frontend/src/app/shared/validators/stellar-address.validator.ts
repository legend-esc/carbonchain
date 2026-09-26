import { Directive } from '@angular/core';
import {
  AbstractControl,
  NG_VALIDATORS,
  ValidationErrors,
  Validator,
  ValidatorFn,
} from '@angular/forms';

/**
 * Base32 alphabet used by Stellar StrKey (RFC 4648 without padding).
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Uint8Array | null {
  let bits = '';
  for (const char of input) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) return null;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

/** CRC16-XModem, as used by Stellar StrKey for the trailing checksum. */
function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

/**
 * Validates a Stellar ed25519 public key (StrKey "G..." address) without
 * depending on @stellar/stellar-sdk: checks length, leading "G", base32
 * decodability, the version byte, and the trailing CRC16 checksum.
 */
export function isValidStellarPublicKey(address: string): boolean {
  if (typeof address !== 'string' || address.length !== 56) return false;
  if (address[0] !== 'G') return false;

  const decoded = base32Decode(address);
  // version byte (1) + raw public key (32) + checksum (2) = 35 bytes
  if (!decoded || decoded.length !== 35) return false;

  const versionByte = decoded[0];
  if (versionByte !== 6 << 3) return false; // 'G' version byte = 48

  const payload = decoded.slice(0, 33);
  const checksum = decoded.slice(33, 35);
  const expected = crc16xmodem(payload);
  const actual = checksum[0] | (checksum[1] << 8);

  return expected === actual;
}

export function stellarAddressValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (!value) return null; // let `required` handle emptiness
    return isValidStellarPublicKey(value) ? null : { stellarAddress: true };
  };
}

/**
 * Reusable reactive-forms validator directive.
 * Usage: <input formControlName="to" stellarAddress>
 */
@Directive({
  selector: '[stellarAddress]',
  providers: [
    {
      provide: NG_VALIDATORS,
      useExisting: StellarAddressValidatorDirective,
      multi: true,
    },
  ],
  standalone: true,
})
export class StellarAddressValidatorDirective implements Validator {
  validate(control: AbstractControl): ValidationErrors | null {
    return stellarAddressValidator()(control);
  }
}
