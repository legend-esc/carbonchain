import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { envValidationSchema } from './env-validation';
import { CacheModule } from './common/cache.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { LoggingMiddleware } from './common/logging.middleware';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
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
import { MetricsModule } from './metrics/metrics.module';
import { RequestMetricsMiddleware } from './metrics/request-metrics.middleware';

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
    // TypeORM — async config so DATABASE_URL is read after ConfigModule loads
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>(
          'DATABASE_URL',
          'postgresql://postgres:postgres@localhost:5432/carbonchain',
        ),
        synchronize: false,
        logging: config.get<string>('NODE_ENV') !== 'production',
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
        migrationsTableName: 'typeorm_migrations',
        poolSize: 20,
        extra: {
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000,
        },
      }),
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
    MetricsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        RequestIdMiddleware,
        LoggingMiddleware,
        RequestMetricsMiddleware,
      )
      .forRoutes('*');
  }
}
