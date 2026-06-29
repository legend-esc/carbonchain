import { IsString, IsNotEmpty, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SplitCreditDto {
  @ApiProperty({
    example: '50000000',
    description: 'tonnes value for the first child credit (must be > 0 and < total tonnes)',
  })
  @IsString()
  @IsNotEmpty()
  splitTonnes: string;

  @ApiProperty({
    example: 1,
    description: 'Nonce for replay protection',
  })
  @IsNumber()
  @IsNotEmpty()
  nonce: number;
}
