import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { EventsService, SorobanEvent } from './events.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private eventsService: EventsService) {}

  /**
   * GET /events — list contract events with optional filters.
   *
   * Issue #931 — keyset/cursor pagination.
   *
   * Keyset mode (recommended):
   *   Pass `beforeCursor` (the `nextCursor` value from a previous response)
   *   to page forward without duplicates under concurrent writes.
   *   Response includes `nextCursor` (null = last page).
   *
   * Deprecated offset mode (backward-compatible):
   *   Pass `skip` + `take` as before; cursor params take precedence.
   */
  @ApiOperation({ summary: 'List contract events — keyset cursor pagination (Issue #931)' })
  @ApiResponse({ status: 200, description: 'Paginated list of events' })
  @ApiQuery({ name: 'contractId', required: false })
  @ApiQuery({ name: 'eventType', required: false })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size (max 200, default 50)',
  })
  @ApiQuery({
    name: 'beforeCursor',
    required: false,
    description:
      'Opaque cursor (event id) from a previous response — enables stable keyset pagination',
  })
  @ApiQuery({
    name: 'take',
    required: false,
    type: Number,
    description: '[Deprecated] use limit instead',
  })
  @ApiQuery({
    name: 'skip',
    required: false,
    type: Number,
    description: '[Deprecated] use cursor pagination instead',
  })
  @Get()
  async getEvents(
    @Query('contractId') contractId?: string,
    @Query('eventType') eventType?: string,
    @Query('limit') limit?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('beforeCursor') beforeCursor?: string,
  ): Promise<{ events: SorobanEvent[]; nextCursor: string | null }> {
    // `limit` takes precedence over deprecated `take`
    const pageSize = limit ?? take ?? '50';
    return this.eventsService.getEvents(
      contractId,
      eventType,
      Number(pageSize),
      Number(skip ?? 0),
      beforeCursor,
    );
  }

  @ApiOperation({ summary: 'Get event by ID' })
  @ApiResponse({ status: 200, description: 'Event details' })
  @ApiResponse({ status: 404, description: 'Event not found' })
  @Get(':eventId')
  async getEventById(
    @Param('eventId') eventId: string,
  ): Promise<SorobanEvent | undefined> {
    return this.eventsService.getEventById(eventId);
  }
}
