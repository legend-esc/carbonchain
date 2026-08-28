import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { signal } from '@angular/core';
import { authGuard } from './auth.guard';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';

function runGuard() {
  return TestBed.runInInjectionContext(() => authGuard({} as any, {} as any));
}

describe('authGuard', () => {
  let mockUrlTree: UrlTree;
  let createUrlTree: ReturnType<typeof vi.fn>;
  let toastShow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUrlTree = {} as UrlTree;
    createUrlTree = vi.fn().mockReturnValue(mockUrlTree);
    toastShow = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { createUrlTree } },
        { provide: AuthService, useValue: { isAuthenticated: signal(false) } },
        { provide: ToastService, useValue: { show: toastShow } },
      ],
    });
  });

  it('should return true when authenticated', () => {
    TestBed.overrideProvider(AuthService, {
      useValue: { isAuthenticated: signal(true) },
    });
    expect(runGuard()).toBe(true);
  });

  it('should redirect to "/" when not authenticated', () => {
    const result = runGuard();
    expect(createUrlTree).toHaveBeenCalledWith(['/']);
    expect(result).toBe(mockUrlTree);
  });

  it('shows a toast message when redirecting unauthenticated user', () => {
    runGuard();
    expect(toastShow).toHaveBeenCalledWith('Please connect your wallet to continue', 'info');
  });

  it('does not show toast when user is authenticated', () => {
    TestBed.overrideProvider(AuthService, {
      useValue: { isAuthenticated: signal(true) },
    });
    runGuard();
    expect(toastShow).not.toHaveBeenCalled();
  });
});
