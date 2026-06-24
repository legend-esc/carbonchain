import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { signal } from '@angular/core';
import { authGuard } from './auth.guard';
import { AuthService } from '../services/auth.service';

function runGuard() {
  return TestBed.runInInjectionContext(() => authGuard({} as any, {} as any));
}

describe('authGuard', () => {
  let mockUrlTree: UrlTree;
  let createUrlTree: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockUrlTree = {} as UrlTree;
    createUrlTree = vi.fn().mockReturnValue(mockUrlTree);

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { createUrlTree } },
        { provide: AuthService, useValue: { isAuthenticated: signal(false) } },
      ],
    });
  });

  it('should return true when authenticated', () => {
    TestBed.overrideProvider(AuthService, {
      useValue: { isAuthenticated: signal(true) },
    });
    expect(runGuard()).toBe(true);
  });

  it('should redirect to /connect-wallet when not authenticated', () => {
    const result = runGuard();
    expect(createUrlTree).toHaveBeenCalledWith(['/connect-wallet']);
    expect(result).toBe(mockUrlTree);
  });
});
