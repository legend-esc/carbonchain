import {
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMaxSize,
  IsNumber,
  ArrayNotEmpty,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  Validate,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

@ValidatorConstraint({ name: 'arraysEqualLength', async: false })
export class ArraysEqualLengthConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as BatchRetireDto;
    if (!Array.isArray(obj.creditIds) || !Array.isArray(obj.tonnes))
      return false;
    return obj.creditIds.length === obj.tonnes.length;
  }

  defaultMessage(): string {
    return 'creditIds and tonnes arrays must have the same length';
  }
}

export class BatchRetireDto {
  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the buyer',
  })
  @IsString()
  @IsNotEmpty()
  buyerPublicKey: string;

  @ApiProperty({
    example: ['037176a1...', 'a1b2c3d4...'],
    description: 'Hex-encoded credit IDs (max 10)',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  creditIds: string[];

  @ApiProperty({
    example: ['1000000', '2000000'],
    description: 'Tonnes for each credit (must match creditIds length)',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @Validate(ArraysEqualLengthConstraint)
  tonnes: string[];

  @ApiProperty({ example: '2024 Scope 3 offset' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiProperty({ example: 1, description: 'Nonce for replay protection' })
  @IsNumber()
  @IsNotEmpty()
  nonce: number;
}
