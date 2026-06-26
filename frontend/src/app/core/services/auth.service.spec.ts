import { TestBed } from '@angular/core/testing';
import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { authInterceptor } from '../interceptors/auth.interceptor';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';

describe('authInterceptor — 401 redirect', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let clearSession: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let toastShow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearSession = vi.fn();
    navigate = vi.fn();
    toastShow = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            clearSession,
            token: signal<string | null>(null),
            isAuthenticated: signal(false),
          },
        },
        { provide: Router, useValue: { navigate } },
        { provide: ToastService, useValue: { show: toastShow } },
      ],
    });

    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('calls clearSession() on 401 response', () => {
    http.get('/api/credits').subscribe({ error: () => {} });
    controller.expectOne('/api/credits').flush('Unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
    });
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it('redirects to "/" on 401 response', () => {
    http.get('/api/credits').subscribe({ error: () => {} });
    controller.expectOne('/api/credits').flush('Unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
    });
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  it('shows a toast message on 401 response', () => {
    http.get('/api/credits').subscribe({ error: () => {} });
    controller.expectOne('/api/credits').flush('Unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
    });
    expect(toastShow).toHaveBeenCalledWith('Session expired, please reconnect', 'error');
  });

  it('does not call clearSession() on non-401 errors', () => {
    http.get('/api/credits').subscribe({ error: () => {} });
    controller.expectOne('/api/credits').flush('Server Error', {
      status: 500,
      statusText: 'Internal Server Error',
    });
    expect(clearSession).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('token is null after clearSession is invoked (JWT cleared)', () => {
    const tokenSignal = signal<string | null>('some-jwt');
    TestBed.overrideProvider(AuthService, {
      useValue: {
        clearSession: () => tokenSignal.set(null),
        token: tokenSignal,
        isAuthenticated: signal(false),
      },
    });

    http.get('/api/credits').subscribe({ error: () => {} });
    controller.expectOne('/api/credits').flush('Unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
    });
    expect(tokenSignal()).toBeNull();
  });
});
