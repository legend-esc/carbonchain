import { Injectable, LoggerService } from '@nestjs/common';
import { pinoLogger } from './logger';

@Injectable()
export class PinoNestLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    pinoLogger.info({ context }, this.stringify(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    pinoLogger.error({ context, trace }, this.stringify(message));
  }

  warn(message: unknown, context?: string): void {
    pinoLogger.warn({ context }, this.stringify(message));
  }

  debug(message: unknown, context?: string): void {
    pinoLogger.debug({ context }, this.stringify(message));
  }

  verbose(message: unknown, context?: string): void {
    pinoLogger.trace({ context }, this.stringify(message));
  }

  private stringify(message: unknown): string {
    return typeof message === 'string' ? message : JSON.stringify(message);
  }
}
