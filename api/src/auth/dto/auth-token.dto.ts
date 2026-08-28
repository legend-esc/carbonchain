import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AuthTokenDto {
  @ApiProperty({ description: 'Signed SEP-10 challenge transaction XDR' })
  @IsString()
  @IsNotEmpty()
  transaction: string;
}
