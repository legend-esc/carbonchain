import { IsString, IsNotEmpty, ApiProperty } from '@nestjs/swagger';

export class IntrospectTokenDto {
  @ApiProperty({
    description: 'Access token (JWT) or refresh token (UUID) to introspect',
    example: 'eyJhbGciOiJIUzI1NiJ9...',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}
