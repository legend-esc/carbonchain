import {
  IsArray,
  IsString,
  IsNotEmpty,
  IsIn,
  IsOptional,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BatchStatusTransitionDto {
  @ApiProperty({
    example: ['credit-id-1', 'credit-id-2', 'credit-id-3'],
    description: 'Array of credit IDs to transition (max 100 per request)',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  creditIds: string[];

  @ApiProperty({
    example: 'expire',
    description: 'Action to perform on each credit: "expire" or "dispute"',
    enum: ['expire', 'dispute'],
  })
  @IsString()
  @IsIn(['expire', 'dispute'])
  action: 'expire' | 'dispute';

  @ApiPropertyOptional({
    example: 'bafybeihdwdcefgh...',
    description:
      'IPFS CID of evidence document; required when action is "dispute"',
  })
  @IsOptional()
  @IsString()
  evidenceIpfsHash?: string;

  @ApiPropertyOptional({
    example: 'Batch vintage expiry sweep for 2019 credits',
    description: 'Optional reason for the batch transition',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
