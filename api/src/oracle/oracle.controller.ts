import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OracleService, MrvWebhookDto } from './oracle.service';

@Controller('v1/oracle')
export class OracleController {
  constructor(private readonly oracleService: OracleService) {}

  /** POST /v1/oracle/mrv — ingest MRV data from an authorised oracle */
  @Post('mrv')
  ingestMrv(@Body() dto: MrvWebhookDto): Promise<{ anomaly: boolean }> {
    return this.oracleService.ingestMrvData(dto);
  }

  /** GET /v1/oracle/:projectId/history — fetch MRV history with pagination */
  @UseGuards(AuthGuard('jwt'))
  @Get(':projectId/history')
  async getHistory(
    @Param('projectId') projectId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(10), ParseIntPipe) pageSize: number,
  ): Promise<{ data: unknown[]; page: number; pageSize: number; total: number }> {
    return this.oracleService.getHistory(projectId, page, pageSize);
  }

  /** GET /v1/oracle/:projectId/aggregate — fetch MRV aggregate over time range */
  @UseGuards(AuthGuard('jwt'))
  @Get(':projectId/aggregate')
  async getAggregate(
    @Param('projectId') projectId: string,
    @Query('from', ParseIntPipe) from: number,
    @Query('to', ParseIntPipe) to: number,
  ): Promise<{ sum: number; average: number }> {
    return this.oracleService.getAggregate(projectId, from, to);
  }
}
