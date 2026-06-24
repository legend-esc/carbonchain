import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import * as Joi from 'joi';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CacheModule } from './common/cache.module';
import { StellarModule } from './stellar/stellar.module';
import { CreditsModule } from './credits/credits.module';
import { ProjectsModule } from './projects/projects.module';
import { AuthModule } from './auth/auth.module';
import { VerifiersModule } from './verifiers/verifiers.module';
import { RetirementModule } from './retirement/retirement.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { EventsModule } from './events/events.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    // #46 — validate required env vars on startup; missing vars cause a clear error
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        ADMIN_SECRET_KEY: Joi.string().required(),
        DATABASE_URL: Joi.string().required(),
        JWT_SECRET: Joi.string().required(),
        STELLAR_NETWORK: Joi.string()
          .valid('testnet', 'mainnet')
          .default('testnet'),
        STELLAR_HORIZON_URL: Joi.string().uri().required(),
        STELLAR_SOROBAN_RPC: Joi.string().uri().required(),
        PORT: Joi.number().default(3000),
      }),
      validationOptions: {
        abortEarly: true,
      },
    }),
    ScheduleModule.forRoot(),
    CacheModule,
    StellarModule,
    CreditsModule,
    ProjectsModule,
    AuthModule,
    VerifiersModule,
    RetirementModule,
    MarketplaceModule,
    EventsModule,
    WebhooksModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
