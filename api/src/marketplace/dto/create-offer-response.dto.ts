import { ApiProperty } from '@nestjs/swagger';

export class CreateOfferResponseDto {
  @ApiProperty({
    example: '12345',
    description: 'Unique identifier of the created offer',
  })
  offerId: string;
}
