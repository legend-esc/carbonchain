import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';

/**
 * Redirects unauthenticated users to the home page ('/') with a toast message.
 * Authenticated users are allowed through.
 */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const toast = inject(ToastService);

  if (auth.isAuthenticated()) {
    return true;
  }

  toast.show('Please connect your wallet to continue', 'info');
  return router.createUrlTree(['/']);
};
