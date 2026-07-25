import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';

/**
 * Attaches the JWT (from sessionStorage via AuthService) to every outgoing
 * request as a Bearer token, and handles 401 responses by clearing the session
 * and redirecting to the home page with a toast notification.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const toast = inject(ToastService);
  const router = inject(Router);

  const token = auth.token();
  const authReq = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(authReq).pipe(
    catchError((err) => {
      if (err.status === 401) {
        auth.clearSession();
        toast.show('Session expired, please reconnect', 'error');
        router.navigate(['/']);
      }
      return throwError(() => err);
    }),
  );
};
