import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { validateMethodology } from '../methodologies';

@ValidatorConstraint({ name: 'isValidMethodology', async: false })
export class IsValidMethodologyConstraint implements ValidatorConstraintInterface {
  validate(value: any): boolean {
    if (typeof value !== 'string') {
      return false;
    }
    return validateMethodology(value) === undefined;
  }

  defaultMessage(): string {
    return 'Invalid methodology value';
  }
}

export function IsValidMethodology(validationOptions?: ValidationOptions) {
  return function (target: object, propertyName: string) {
    registerDecorator({
      target: target.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidMethodologyConstraint,
    });
  };
}
