import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isValidMethodology } from '../methodologies';

@ValidatorConstraint({ name: 'isValidMethodology', async: false })
export class IsValidMethodologyConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    return isValidMethodology(value);
  }

  defaultMessage(): string {
    return 'Methodology must be a supported value or start with Custom-';
  }
}

export function IsValidMethodology(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    registerDecorator({
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      constraints: [],
      validator: IsValidMethodologyConstraint,
    });
  };
}
