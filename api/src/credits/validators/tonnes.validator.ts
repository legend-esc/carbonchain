import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const TONNES_MULTIPLIER = 100_000;

@ValidatorConstraint({ name: 'isTonnesMultiple', async: false })
export class IsTonnesMultipleConstraint implements ValidatorConstraintInterface {
  validate(value: any): boolean {
    if (typeof value !== 'string') {
      return false;
    }

    // Check if value is a valid integer string (supports i128 range via BigInt)
    let numValue: bigint;
    try {
      if (!/^-?\d+$/.test(value)) {
        return false;
      }
      numValue = BigInt(value);
    } catch {
      return false;
    }
    if (numValue <= 0n) {
      return false;
    }

    // Check if it's a multiple of TONNES_MULTIPLIER (100,000)
    return numValue % BigInt(TONNES_MULTIPLIER) === 0n;
  }

  defaultMessage(): string {
    return `tonnes must be a multiple of ${TONNES_MULTIPLIER}`;
  }
}

export function IsTonnesMultiple(validationOptions?: ValidationOptions) {
  return function (target: object, propertyName: string) {
    registerDecorator({
      target: target.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsTonnesMultipleConstraint,
    });
  };
}
