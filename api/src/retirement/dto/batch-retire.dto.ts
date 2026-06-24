import { IsArray, IsString, IsNotEmpty, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BatchRetireDto {
  @ApiProperty({
    example: ['037176a1...', '037176a2...'],
    description: 'Array of hex-encoded credit IDs',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  creditIds: string[];

  @ApiProperty({
    example: [1000000, 1000000],
    description: 'Array of tonnes to retire for each credit (1 tonne = 1_000_000 units)',
  })
  @IsArray()
  @ArrayMinSize(1)
  tonnes: string[];

  @ApiProperty({
    example: '2024 Scope 3 offset',
    description: 'Reason for retirement (applies to all credits in batch)',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiProperty({
    example: 'GABC...XYZ',
    description: 'Stellar public key of the buyer',
  })
  @IsString()
  @IsNotEmpty()
  buyerPublicKey: string;
}
