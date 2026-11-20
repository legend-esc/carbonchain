import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { envValidationSchema } from './env-validation';
import { CacheModule } from './common/cache.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { RequestLoggingMiddleware } from './common/request-logging.middleware';
import { IdempotencyMiddleware } from './common/middleware/idempotency.middleware';
import { HealthModule } from './health/health.module';
import { StellarModule } from './stellar/stellar.module';
import { CreditsModule } from './credits/credits.module';
import { ProjectsModule } from './projects/projects.module';
import { AuthModule } from './auth/auth.module';
import { VerifiersModule } from './verifiers/verifiers.module';
import { RetirementModule } from './retirement/retirement.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { EventsModule } from './events/events.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AdminModule } from './admin/admin.module';
import { RatesModule } from './rates/rates.module';

@Module({
  imports: [
    // #46 — validate required env vars on startup; missing vars cause a clear error
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),
    ScheduleModule.forRoot(),
    CacheModule,
    HealthModule,
    StellarModule,
    CreditsModule,
    ProjectsModule,
    AuthModule,
    VerifiersModule,
    RetirementModule,
    MarketplaceModule,
    EventsModule,
    WebhooksModule,
    AdminModule,
    RatesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, RequestLoggingMiddleware)
      .forRoutes('*');

    consumer
      .apply(IdempotencyMiddleware)
      .forRoutes(
        { path: '*', method: RequestMethod.POST },
        { path: '*', method: RequestMethod.PUT },
      );
  }
}
