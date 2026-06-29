import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

@Injectable()
export class RequestMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metricsService: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = {
        method: req.method,
        path: req.route?.path ?? req.originalUrl ?? req.url,
        status_code: String(res.statusCode),
      };

      this.metricsService.httpRequestsTotal?.inc(labels);
      this.metricsService.httpRequestDurationSeconds?.observe(labels, durationSeconds);
    });

    next();
  }
}
