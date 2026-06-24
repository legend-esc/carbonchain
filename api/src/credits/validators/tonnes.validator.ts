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

    // Check if value is a valid number string
    const numValue = Number(value);
    if (isNaN(numValue) || numValue <= 0) {
      return false;
    }

    // Check if it's a multiple of TONNES_MULTIPLIER (100,000)
    return numValue % TONNES_MULTIPLIER === 0;
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
