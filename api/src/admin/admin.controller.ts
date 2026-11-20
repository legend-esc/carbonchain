import { Controller, Get, Post, Param, Body, UseGuards, Res } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminGuard } from './admin.guard';
import { AdminService, AdminStats } from './admin.service';
import { ReportsService } from './reports.service';
import type { VerifierCapabilities } from './admin.service';
import { CreditStatus } from '../shared';
import type { Response as ExpressResponse } from 'express';

@UseGuards(AuthGuard('jwt'), AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly reportsService: ReportsService,
  ) {}

  @Get('stats')
  getStats(): Promise<AdminStats> {
    return this.adminService.getStats();
  }

  @Post('verifiers/register')
  registerVerifier(
    @Body() body: { address: string },
  ): Promise<{ registered: boolean; address: string }> {
    return this.adminService.registerVerifier(body.address);
  }

  @Post('verifiers/:id/suspend')
  suspendVerifier(@Param('id') id: string): Promise<{ suspended: boolean }> {
    return this.adminService.suspendVerifier(id);
  }

  @Post('verifiers/:id/configure')
  configureVerifier(
    @Param('id') id: string,
    @Body() body: VerifierCapabilities,
  ): Promise<{ configured: boolean; verifierId: string }> {
    return this.adminService.configureVerifier(id, body);
  }

  @Post('credits/:id/flag')
  flagCredit(
    @Param('id') id: string,
  ): Promise<{ flagged: boolean; creditId: string; status: CreditStatus }> {
    return this.adminService.flagCredit(id);
  }

  /**
   * GET /admin/reports/export/compliance-csv
   * Streams UNFCCC/SEC-format CSV. Restricted to Admin or Auditor roles.
   */
  @Get('reports/export/compliance-csv')
  async exportComplianceCsv(
    @Res() res: ExpressResponse,
  ): Promise<void> {
    // Role comes from JWT; AdminGuard already checks for 'admin', but
    // ReportsService also gates on 'admin' | 'auditor' at the service level.
    const req = (res as unknown as { req: { user?: { role?: string } } }).req;
    const role = req?.user?.role ?? 'admin';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="compliance-export.csv"',
    );
    res.setHeader('Transfer-Encoding', 'chunked');

    const generator = this.reportsService.generateComplianceCsv(role);
    for await (const chunk of generator) {
      res.write(chunk);
    }
    res.end();
  }
}
