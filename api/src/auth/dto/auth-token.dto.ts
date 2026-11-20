import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AuthTokenDto {
  @ApiProperty({
    description:
      'Signed SEP-10 challenge transaction XDR (base64-encoded Stellar transaction envelope). ' +
      'Obtain this from POST /auth/challenge and sign it with the account keypair before submitting to POST /auth/verify.',
    example: 'AAAAAgAAAABg7t8Q2vX9r0m1s2c3d4e5...',
  })
  @IsString()
  @IsNotEmpty()
  transaction: string;
}
