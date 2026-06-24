import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { RetirementService, RetireDto } from './retirement.service';
import { RetirementRecord } from '../shared';

@Controller('retirement')
export class RetirementController {
  constructor(private readonly retirementService: RetirementService) {}

  /** POST /retirement — retire a credit */
  @Post()
  retire(@Body() dto: RetireDto): Promise<{ retirementId: string }> {
    return this.retirementService.retire(dto);
  }

  /** POST /retirement/batch — retire multiple credits in one call */
  @Post('batch')
  batchRetire(@Body() dtos: RetireDto[]): Promise<{ retirementIds: string[] }> {
    return this.retirementService.batchRetire(dtos);
  }

  /** GET /retirement/:id — fetch a retirement record */
  @Get(':id')
  getRetirement(@Param('id') id: string): Promise<RetirementRecord> {
    return this.retirementService.getRetirement(id);
  }

  /** GET /retirement/account/:address — list retirements for an account */
  @Get('account/:address')
  getByAccount(@Param('address') address: string): Promise<string[]> {
    return this.retirementService.getRetirementsByAccount(address);
  }
}
