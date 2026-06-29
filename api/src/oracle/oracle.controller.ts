import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { OracleService, MrvWebhookDto } from './oracle.service';

@ApiTags('oracle')
@Controller('oracle')
export class OracleController {
  constructor(private readonly oracleService: OracleService) {}

  @ApiOperation({ summary: 'Ingest MRV data from an authorised oracle' })
  @ApiResponse({ status: 201, description: 'MRV data ingested, returns anomaly flag' })
  @ApiResponse({ status: 401, description: 'Invalid oracle signature' })
  @Post('mrv')
  ingestMrv(@Body() dto: MrvWebhookDto): Promise<{ anomaly: boolean }> {
    return this.oracleService.ingestMrvData(dto);
  }
}
