import {
  HttpInterceptorFn,
  HttpRequest,
  HttpHandlerFn,
  HttpEvent,
  HttpResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable } from 'rxjs';
import { filter, map, tap } from 'rxjs/operators';

/**
 * Issue #966 — Conditional GET / 304 interceptor.
 *
 * Caches successful GET responses keyed by URL and reuses the cached body
 * when the server responds with 304 Not Modified (driven by If-None-Match).
 *
 * Scope: only GET requests to `/api/portfolio*`, `/api/marketplace*`,
 * and `/api/retirement*` are cached to avoid over-caching mutable state.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  body: unknown;
  etag: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function isCacheable(req: HttpRequest<unknown>): boolean {
  if (req.method !== 'GET') return false;
  const url = req.url;
  return url.includes('/portfolio') || url.includes('/marketplace') || url.includes('/retirement');
}

export const conditionalRequestInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> => {
  if (!isCacheable(req)) {
    return next(req);
  }

  const cached = cache.get(req.url);
  const cloned = cached?.etag
    ? req.clone({
        setHeaders: {
          ...req.headers.keys().reduce<Record<string, string>>((acc, key) => {
            acc[key] = req.headers.get(key) || '';
            return acc;
          }, {}),
          'If-None-Match': cached.etag,
        },
      })
    : req;

  return next(cloned).pipe(
    filter((event) => event instanceof HttpResponse),
    tap((event) => {
      const response = event as HttpResponse<unknown>;
      if (response.status === 304 && cached) {
        cache.set(req.url, { ...cached, expiresAt: Date.now() + CACHE_TTL_MS });
      } else if (response.status === 200) {
        const etag = response.headers.get('ETag') ?? response.headers.get('etag');
        cache.set(req.url, {
          body: response.body,
          etag: etag,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
      }
    }),
    map((event) => {
      const response = event as HttpResponse<unknown>;
      if (response.status === 304 && cached) {
        return new HttpResponse({
          ...response,
          body: cached.body,
          status: 200,
          statusText: 'OK (cached)',
          url: response.url ?? '',
        });
      }
      return response;
    }),
  );
};
