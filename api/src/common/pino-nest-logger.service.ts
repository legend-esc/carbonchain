import { Injectable, LoggerService } from '@nestjs/common';
import { pinoLogger } from './logger';
import { RequestContextStore } from './request-context';

@Injectable()
export class PinoNestLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    pinoLogger.info({ ...this.requestCtx(), context }, this.stringify(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    pinoLogger.error({ ...this.requestCtx(), context, trace }, this.stringify(message));
  }

  warn(message: unknown, context?: string): void {
    pinoLogger.warn({ ...this.requestCtx(), context }, this.stringify(message));
  }

  debug(message: unknown, context?: string): void {
    pinoLogger.debug({ ...this.requestCtx(), context }, this.stringify(message));
  }

  verbose(message: unknown, context?: string): void {
    pinoLogger.trace({ ...this.requestCtx(), context }, this.stringify(message));
  }

  private stringify(message: unknown): string {
    return typeof message === 'string' ? message : JSON.stringify(message);
  }

  private requestCtx(): { requestId?: string } {
    return { requestId: RequestContextStore.getRequestId() };
  }
}
