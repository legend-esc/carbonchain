import { Controller, Get, Param, Query } from '@nestjs/common';
import { EventsService, SorobanEvent } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private eventsService: EventsService) {}

  @Get()
  getEvents(
    @Query('contractId') contractId?: string,
    @Query('eventType') eventType?: string,
    @Query('take') take = 50,
    @Query('skip') skip = 0,
  ): SorobanEvent[] {
    return this.eventsService.getEvents(contractId, eventType, Number(take), Number(skip));
  }

  @Get(':eventId')
  getEventById(@Param('eventId') eventId: string): SorobanEvent | undefined {
    return this.eventsService.getEventById(eventId);
  }
}
