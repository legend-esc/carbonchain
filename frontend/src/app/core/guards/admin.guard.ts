import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/connect-wallet']);
  }

  const token = auth.token();
  if (token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1])) as { role?: string };
      if (payload.role === 'admin') return true;
    } catch {
      // malformed token — fall through to redirect
    }
  }

  return router.createUrlTree(['/dashboard']);
};
