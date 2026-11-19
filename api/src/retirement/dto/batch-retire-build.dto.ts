import { IsString, IsNotEmpty, IsArray, ArrayMaxSize, ArrayNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BatchRetireBuildDto {
  @ApiProperty({ example: ['credit-1', 'credit-2'], description: 'Credit IDs to retire (max 20)' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  creditIds: string[];

  @ApiProperty({ example: '2024 Scope 3 offset' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
