import {
  ApplicationConfig,
  APP_INITIALIZER,
  ErrorHandler,
  inject,
  isDevMode,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';

import { provideRouter } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { GlobalErrorHandler } from './core/handlers/global-error.handler';
import { TranslationService } from './core/services/translation.service';
import { initSentry } from './core/services/sentry-config';

function initializeTranslations(): () => Promise<void> {
  const i18n = inject(TranslationService);
  return () => i18n.init();
}

export const appConfig: ApplicationConfig = {
  providers: [
    // Initialize Sentry as early as possible (production-only, DSN optional)
    {
      provide: APP_INITIALIZER,
      multi: true,
      useFactory: () => {
        const dsn = (window as any)?.__SENTRY_DSN__ as string | undefined;
        return () => initSentry(dsn);
      },
    },

    provideBrowserGlobalErrorListeners(),

    provideRouter(routes),
    provideHttpClient(withFetch()),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    { provide: APP_INITIALIZER, useFactory: initializeTranslations, multi: true },
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
