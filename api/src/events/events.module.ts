import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { EventEntity } from './event.entity';
import { StellarModule } from '../stellar/stellar.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EventEntity]),
    StellarModule,
    WebhooksModule,
  ],
  providers: [EventsService],
  controllers: [EventsController],
  exports: [EventsService],
})
export class EventsModule {}
