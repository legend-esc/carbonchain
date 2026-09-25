import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_PATTERN = /^b[a-z2-7]+$/;

@ValidatorConstraint({ name: 'isIpfsCid', async: false })
export class IsIpfsCidConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      typeof value === 'string' &&
      (CID_V0_PATTERN.test(value) || CID_V1_PATTERN.test(value))
    );
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid IPFS CID`;
  }
}

export function IsIpfsCid(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    registerDecorator({
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      constraints: [],
      validator: IsIpfsCidConstraint,
    });
  };
}

export const IsIPFSCID = IsIpfsCid;
