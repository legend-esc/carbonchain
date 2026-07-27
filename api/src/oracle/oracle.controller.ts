import {
  Controller,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { OracleService, MrvWebhookDto } from './oracle.service';
import { AdminGuard } from '../admin/admin.guard';

@ApiTags('oracle')
@Controller('oracle')
export class OracleController {
  constructor(private readonly oracleService: OracleService) {}

  @ApiOperation({ summary: 'Ingest MRV data from an authorised oracle' })
  @ApiResponse({
    status: 201,
    description: 'MRV data ingested, returns anomaly flag',
  })
  @ApiResponse({ status: 401, description: 'Invalid oracle signature' })
  @Post('mrv')
  ingestMrv(@Body() dto: MrvWebhookDto): Promise<{ anomaly: boolean }> {
    return this.oracleService.ingestMrvData(dto);
  }

  @ApiOperation({
    summary:
      'Set per-project anomaly threshold override (admin only). Pass thresholdBps=0 to clear.',
  })
  @ApiBearerAuth()
  @ApiResponse({ status: 200, description: 'Threshold updated' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin only' })
  @UseGuards(AuthGuard('jwt'), AdminGuard)
  @Patch(':projectId/threshold')
  @HttpCode(HttpStatus.OK)
  async setProjectThreshold(
    @Param('projectId') projectId: string,
    @Body() body: { thresholdBps: number },
  ): Promise<{ projectId: string; thresholdBps: number | null }> {
    return this.oracleService.setProjectAnomalyThreshold(
      projectId,
      body.thresholdBps,
    );
  }
}
