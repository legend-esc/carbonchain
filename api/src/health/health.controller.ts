import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(@Res() res: Response): Promise<void> {
    const result = await this.healthService.check();
    res
      .status(
        result.status === 'ok'
          ? HttpStatus.OK
          : HttpStatus.SERVICE_UNAVAILABLE,
      )
      .json(result);
  }
}
