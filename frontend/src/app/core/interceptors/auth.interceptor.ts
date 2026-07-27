import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';

/**
 * Issue #507: Angular HTTP interceptor that automatically attaches the stored
 * JWT as `Authorization: Bearer <token>` on every request to the API origin.
 *
 * Rules:
 * - Only attaches the header to requests whose URL starts with `/api` (the
 *   configured API base path).  External requests to Horizon or IPFS gateways
 *   are left untouched.
 * - On a 401 response the stored token is cleared and the user is redirected
 *   to the wallet-connect page.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const toast = inject(ToastService);
  const router = inject(Router);

  // Only attach the JWT to requests aimed at our own API (relative paths
  // starting with /api, or absolute URLs containing /api/).
  const isApiRequest =
    req.url.startsWith('/api') || req.url.includes('/api/');

  const token = auth.token();

  const authorizedReq =
    isApiRequest && token
      ? req.clone({
          setHeaders: { Authorization: `Bearer ${token}` },
        })
      : req;

  return next(authorizedReq).pipe(
    catchError((err) => {
      if (err.status === 401) {
        auth.clearSession();
        toast.show('Session expired, please reconnect', 'error');
        void router.navigate(['/']);
      }
      return throwError(() => err as unknown);
    }),
  );
};
