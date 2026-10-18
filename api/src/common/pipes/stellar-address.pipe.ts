import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { IsStellarAddressConstraint } from '../validators/is-stellar-address.decorator';

/**
 * Parameter-level pipe that validates a Stellar ed25519 public key.
 * Reuses the IsStellarAddressConstraint from the class-validator decorator so
 * the validation rule is defined in exactly one place.
 *
 * Usage:
 *   @Param('address', StellarAddressPipe) address: string
 */
@Injectable()
export class StellarAddressPipe implements PipeTransform<string, string> {
  private readonly constraint = new IsStellarAddressConstraint();

  transform(value: string): string {
    if (!this.constraint.validate(value)) {
      throw new BadRequestException(this.constraint.defaultMessage());
    }
    return value;
  }
}
