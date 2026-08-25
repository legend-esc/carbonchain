import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';

// Issue #590: security.txt content served at /.well-known/security.txt per RFC 9116.
// Update the Expires date annually before it lapses.
const SECURITY_TXT = `# CarbonChain Security Policy
# RFC 9116 — https://www.rfc-editor.org/rfc/rfc9116

Contact: mailto:security@carbonchain.example.com
Expires: 2027-12-31T23:59:59Z
Preferred-Languages: en
Policy: https://github.com/legend-esc/carbonchain/blob/main/SECURITY.md
`;

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  @ApiResponse({ status: 503, description: 'Service is unhealthy' })
  @Get('health')
  async check(@Res() res: Response): Promise<void> {
    const result = await this.healthService.check();
    res
      .status(
        result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
      )
      .json(result);
  }

  // Issue #590: RFC 9116 security contact discovery endpoint.
  // Accessible at https://api.carbonchain.example.com/.well-known/security.txt
  @ApiOperation({ summary: 'Security disclosure contact (RFC 9116)' })
  @ApiResponse({ status: 200, description: 'security.txt content' })
  @Get('.well-known/security.txt')
  securityTxt(@Res() res: Response): void {
    res
      .status(HttpStatus.OK)
      .header('Content-Type', 'text/plain; charset=utf-8')
      .send(SECURITY_TXT);
  }
}
