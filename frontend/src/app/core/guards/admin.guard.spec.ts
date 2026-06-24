import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { adminGuard } from './admin.guard';
import { AuthService } from '../services/auth.service';

function makeAuthStub(admin: boolean): Partial<AuthService> {
  return { isAdmin: signal(admin) } as unknown as Partial<AuthService>;
}

function runGuard(): boolean | UrlTree {
  return TestBed.runInInjectionContext(() =>
    adminGuard({} as never, {} as never),
  ) as boolean | UrlTree;
}

describe('adminGuard', () => {
  let router: Router;

  function setup(isAdmin: boolean): void {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: makeAuthStub(isAdmin) },
        provideRouter([]),
      ],
    });
    router = TestBed.inject(Router);
  }

  it('returns true when user is admin', () => {
    setup(true);
    expect(runGuard()).toBe(true);
  });

  it('redirects to /dashboard when user is not admin', () => {
    setup(false);
    const result = runGuard();
    expect(result instanceof UrlTree).toBe(true);
    expect(router.serializeUrl(result as UrlTree)).toBe('/dashboard');
  });
});
