import { IsArray, IsIn, IsNumber, IsPositive, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

const ACTIVITY_TYPES = [
  'flight_short_haul',
  'flight_long_haul',
  'car_petrol',
  'car_diesel',
  'train',
  'electricity',
  'natural_gas',
  'data_center_kwh',
  'server_hours',
] as const;

export class ActivityInputDto {
  @ApiProperty({
    enum: ACTIVITY_TYPES,
    example: 'flight_short_haul',
    description: 'Activity type determines the emission factor applied',
  })
  @IsIn(ACTIVITY_TYPES)
  type: string;

  @ApiProperty({
    example: 1500,
    description:
      'Quantity in natural unit: km for travel, kWh for energy, hours for server_hours',
  })
  @IsNumber()
  @IsPositive()
  quantity: number;
}

export class EstimateDto {
  @ApiProperty({
    type: [ActivityInputDto],
    description: 'One or more activities to include in the estimate',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ActivityInputDto)
  activities: ActivityInputDto[];
}
