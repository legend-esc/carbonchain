import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RetireDto {
  @ApiProperty({ example: '2024 Scope 3 offset', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;
}
