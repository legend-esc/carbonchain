import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { StrKey } from '@stellar/stellar-sdk';

@ValidatorConstraint({ name: 'isStellarAddress', async: false })
export class IsStellarAddressConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    return typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);
  }

  defaultMessage(): string {
    return 'Invalid Stellar address (must start with G and be 56 chars)';
  }
}

/**
 * class-validator decorator for DTO fields carrying a Stellar ed25519
 * public key. Drop-in alongside @IsString():
 *
 *   @IsString()
 *   @IsStellarAddress()
 *   to: string;
 */
export function IsStellarAddress(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsStellarAddressConstraint,
    });
  };
}
