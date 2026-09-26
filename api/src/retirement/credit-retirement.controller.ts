import {
  Controller,
  Post,
  Param,
  Body,
  UseGuards,
  Request,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RetirementService } from './retirement.service';
import { RetireDto } from './dto/retire.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('credits')
@Controller('credits')
export class CreditRetirementController {
  constructor(private readonly retirementService: RetirementService) {}

  @ApiOperation({
    summary: 'Retire a carbon credit and generate a certificate',
  })
  @ApiResponse({ status: 201, description: 'Credit retired successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 404,
    description: 'Credit not found in off-chain index',
  })
  @ApiResponse({ status: 409, description: 'Credit is not active' })
  @UseGuards(JwtAuthGuard)
  @Post(':id/retire')
  @HttpCode(201)
  retireCredit(
    @Param('id') creditId: string,
    @Body() dto: RetireDto,
    @Request() req: { user: { account: string } },
  ): Promise<{ retirementId: string; certificateIpfsHash: string }> {
    return this.retirementService.retireCredit(creditId, dto, req.user.account);
  }
}
