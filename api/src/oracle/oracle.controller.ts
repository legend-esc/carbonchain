import { Controller, Post, Body } from '@nestjs/common';
import { OracleService, MrvWebhookDto } from './oracle.service';

@Controller('oracle')
export class OracleController {
  constructor(private readonly oracleService: OracleService) {}

  /** POST /oracle/mrv — ingest MRV data from an authorised oracle */
  @Post('mrv')
  ingestMrv(@Body() dto: MrvWebhookDto): Promise<{ anomaly: boolean }> {
    return this.oracleService.ingestMrvData(dto);
  }
}
