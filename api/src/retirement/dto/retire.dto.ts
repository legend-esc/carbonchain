import { IsString, IsNotEmpty, MaxLength, IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RetireDto {
  @ApiProperty({ example: '2024 Scope 3 offset', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;

  @ApiProperty({
    example: 0,
    description: 'Replay-protection nonce from the contract',
    default: 0,
  })
  @IsInt()
  @Min(0)
  nonce: number = 0;
}

/** Full retirement payload used by the service and the POST /retirement endpoint. */
export class FullRetireDto {
  buyerPublicKey: string;
  creditId: string;
  tonnes: string;
  reason: string;
  nonce: number;
}
