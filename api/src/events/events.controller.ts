import { Controller, Get, Query } from '@nestjs/common';
import { EventsService, SorobanEvent } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private eventsService: EventsService) {}

  @Get()
  getEvents(
    @Query('contractId') contractId?: string,
    @Query('eventType') eventType?: string,
    @Query('limit') limit = 100,
  ): SorobanEvent[] {
    return this.eventsService.getEvents(contractId, eventType, limit);
  }

  @Get(':eventId')
  getEventById(@Query('eventId') eventId: string): SorobanEvent | undefined {
    return this.eventsService.getEventById(eventId);
  }
}
