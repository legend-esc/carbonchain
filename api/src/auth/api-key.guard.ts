import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiKeyService } from './api-key.service';

/**
 * Issue #1292 — Guard to validate X-API-Key header and enforce quota limits.
 * Bypasses IP-based rate limiting for authorized API keys.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private apiKeyService: ApiKeyService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];

    if (!apiKey) {
      // No API key provided — fall through to IP-based rate limiting
      return true;
    }

    // Validate the API key
    const keyRecord = this.apiKeyService.validateApiKey(apiKey);
    if (!keyRecord) {
      throw new UnauthorizedException('Invalid or inactive API key');
    }

    // Check quota
    if (!this.apiKeyService.hasAvailableQuota(keyRecord, 1)) {
      throw new ForbiddenException(
        `API key quota exceeded. Monthly limit: ${this.apiKeyService.getTier(keyRecord).monthlyQuota}`,
      );
    }

    // Increment usage
    this.apiKeyService.incrementUsage(keyRecord, 1);

    // Attach key record to request for downstream use
    request.apiKey = keyRecord;
    request.bypassIpThrottling =
      this.apiKeyService.getTier(keyRecord).bypassIpThrottling;

    return true;
  }
}
