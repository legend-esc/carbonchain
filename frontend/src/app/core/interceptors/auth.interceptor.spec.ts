import { TestBed } from '@angular/core/testing';
import {
  HttpClient,
  HttpStatusCode,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';

describe('authInterceptor (Issue #507)', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let mockAuth: jasmine.SpyObj<AuthService> & { token: ReturnType<typeof signal<string | null>> };
  let mockToast: jasmine.SpyObj<ToastService>;
  let mockRouter: jasmine.SpyObj<Router>;

  const JWT = 'eyJhbGciOiJIUzI1NiJ9.test.sig';

  beforeEach(() => {
    // Build a signal-based token mock that matches AuthService.token shape.
    const tokenSignal = signal<string | null>(JWT);
    mockAuth = {
      token: tokenSignal,
      clearSession: jasmine.createSpy('clearSession'),
    } as any;

    mockToast = jasmine.createSpyObj('ToastService', ['show']);
    mockRouter = jasmine.createSpyObj('Router', ['navigate']);
    mockRouter.navigate.and.returnValue(Promise.resolve(true));

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: mockAuth },
        { provide: ToastService, useValue: mockToast },
        { provide: Router, useValue: mockRouter },
      ],
    });

    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('attaches Authorization header to /api requests when token is present', () => {
    http.get('/api/credits').subscribe();
    const req = controller.expectOne('/api/credits');
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${JWT}`);
    req.flush([]);
  });

  it('does not attach Authorization header when no token is stored', () => {
    mockAuth.token.set(null);
    http.get('/api/credits').subscribe();
    const req = controller.expectOne('/api/credits');
    expect(req.request.headers.has('Authorization')).toBeFalse();
    req.flush([]);
  });

  it('does not attach Authorization header to non-API requests', () => {
    http.get('https://horizon-testnet.stellar.org/accounts/G123').subscribe();
    const req = controller.expectOne(
      'https://horizon-testnet.stellar.org/accounts/G123',
    );
    expect(req.request.headers.has('Authorization')).toBeFalse();
    req.flush({});
  });

  it('calls clearSession and redirects on 401 response', () => {
    http.get('/api/protected').subscribe({ error: () => {} });
    const req = controller.expectOne('/api/protected');
    req.flush('Unauthorized', {
      status: HttpStatusCode.Unauthorized,
      statusText: 'Unauthorized',
    });
    expect(mockAuth.clearSession).toHaveBeenCalled();
    expect(mockToast.show).toHaveBeenCalledWith(
      'Session expired, please reconnect',
      'error',
    );
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/']);
  });

  it('does not clear session on non-401 errors', () => {
    http.get('/api/credits').subscribe({ error: () => {} });
    const req = controller.expectOne('/api/credits');
    req.flush('Not Found', {
      status: HttpStatusCode.NotFound,
      statusText: 'Not Found',
    });
    expect(mockAuth.clearSession).not.toHaveBeenCalled();
  });
});
