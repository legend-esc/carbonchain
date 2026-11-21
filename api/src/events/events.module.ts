import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { EventEntity } from './event.entity';
import { EventBackfillService } from './event-backfill.service';
import { PartitionCleanupTask } from './partition-cleanup.task';
import { StellarModule } from '../stellar/stellar.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EventEntity]),
    StellarModule,
    WebhooksModule,
  ],
  providers: [EventsService, EventBackfillService, PartitionCleanupTask],
  controllers: [EventsController],
  exports: [EventsService],
})
export class EventsModule {}
