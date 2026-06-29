import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { EventsService, SorobanEvent } from './events.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private eventsService: EventsService) {}

  @ApiOperation({ summary: 'List contract events with filters' })
  @ApiResponse({ status: 200, description: 'List of events' })
  @Get()
  getEvents(
    @Query('contractId') contractId?: string,
    @Query('eventType') eventType?: string,
    @Query('take') take = 50,
    @Query('skip') skip = 0,
  ): SorobanEvent[] {
    return this.eventsService.getEvents(contractId, eventType, Number(take), Number(skip));
  }

  @ApiOperation({ summary: 'Get event by ID' })
  @ApiResponse({ status: 200, description: 'Event details' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  @Get(':eventId')
  getEventById(@Param('eventId') eventId: string): SorobanEvent | undefined {
    return this.eventsService.getEventById(eventId);
  }
}
