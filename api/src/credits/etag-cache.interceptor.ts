import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  SetMetadata,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { createHash } from 'crypto';
import { CreditStatus } from '../../../shared';

export const CACHE_CONTROL_KEY = 'cache_control';
export const CacheControl = (policy: string) =>
  SetMetadata(CACHE_CONTROL_KEY, policy);

/**
 * Interceptor that adds ETag and Cache-Control headers to credit responses.
 *
 * ETag is computed from stable fields (id, status, owner, tonnes) —
 * excluding issued_at which is server-generated and may drift.
 *
 * Cache-Control:
 *   - Active credits: public, max-age=30
 *   - Retired/Flagged credits: no-store (sensitive lifecycle state)
 */
@Injectable()
export class ETagCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse();

    return next.handle().pipe(
      map((body) => {
        if (
          body &&
          typeof body === 'object' &&
          'id' in body &&
          'status' in body
        ) {
          const credit = body as {
            id: string;
            status: CreditStatus;
            owner?: string;
            issuer?: string;
            tonnes: string;
          };

          // Compute ETag from stable fields (exclude issued_at)
          const etagSource = `${credit.id}:${credit.status}:${credit.owner ?? credit.issuer}:${credit.tonnes}`;
          const etag = `"${createHash('sha256').update(etagSource).digest('hex').slice(0, 16)}"`;

          response.setHeader('ETag', etag);

          // Set Cache-Control based on credit status
          if (
            credit.status === CreditStatus.Retired ||
            credit.status === CreditStatus.Flagged
          ) {
            response.setHeader('Cache-Control', 'no-store');
          } else {
            response.setHeader('Cache-Control', 'public, max-age=30');
          }

          // Handle If-None-Match for 304 responses
          const ifNoneMatch = context.switchToHttp().getRequest().headers[
            'if-none-match'
          ];
          if (ifNoneMatch === etag) {
            response.status(304);
            return null;
          }
        }
        return body;
      }),
    );
  }
}
