import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiProperty({ example: 'Amazon Reforestation' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'GreenCorp Ltd' })
  @IsString()
  @IsNotEmpty()
  developer: string;

  @ApiProperty({ example: 'Reforestation of degraded Amazon land' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({
    example: 'BR',
    description: 'ISO 3166-1 alpha-2 country code',
  })
  @IsString()
  @IsNotEmpty()
  location: string;

  @ApiProperty({ example: 'REDD+' })
  @IsString()
  @IsNotEmpty()
  methodology: string;

  @ApiProperty({
    example: 'bafybei...',
    description: 'IPFS CID of project documents',
  })
  @IsString()
  @IsNotEmpty()
  documents_cid: string;
}
