import { Global, Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsListener } from './metrics-listener';
import { InternalNetworkMiddleware } from './internal-network.middleware';
import { metricsEventEmitterProvider } from './metrics-events';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsListener, metricsEventEmitterProvider],
  exports: [MetricsService, metricsEventEmitterProvider],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(InternalNetworkMiddleware).forRoutes('metrics');
  }
}
