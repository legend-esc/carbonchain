import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { authInterceptor } from '../interceptors/auth.interceptor';
import { AuthService } from './auth.service';
import { StellarWalletService } from './stellar-wallet.service';
import { ApiService } from './api.service';
import { ToastService } from './toast.service';

// ---------------------------------------------------------------------------
// AuthService
// ---------------------------------------------------------------------------

describe('AuthService', () => {
  let service: AuthService;
  let walletMock: Partial<StellarWalletService>;
  let apiMock: Partial<ApiService>;

  beforeEach(() => {
    sessionStorage.clear();

    walletMock = {
      connect: vi.fn().mockResolvedValue('GPUBKEY123'),
      signTransaction: vi.fn().mockResolvedValue('signedXDR'),
      disconnect: vi.fn(),
      isConnected: signal(false).asReadonly(),
      publicKey: signal<string | null>(null).asReadonly(),
      state: signal('disconnected' as const).asReadonly(),
    };

    apiMock = {
      getChallenge: vi.fn().mockReturnValue(
        of({ transaction: 'challengeXDR', network_passphrase: 'Test SDF Network ; September 2015' }),
      ),
      getToken: vi.fn().mockReturnValue(of({ access_token: 'mock.jwt.token' })),
    };

    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: StellarWalletService, useValue: walletMock },
        { provide: ApiService, useValue: apiMock },
      ],
    });

    service = TestBed.inject(AuthService);
  });

  afterEach(() => sessionStorage.clear());

  it('starts unauthenticated when sessionStorage is empty', () => {
    expect(service.isAuthenticated()).toBe(false);
    expect(service.authState()).toBe('unauthenticated');
    expect(service.token()).toBeNull();
  });

  it('connect() completes the full SEP-10 handshake', async () => {
    await service.connect();

    expect(walletMock.connect).toHaveBeenCalledTimes(1);
    expect(apiMock.getChallenge).toHaveBeenCalledWith('GPUBKEY123');
    expect(walletMock.signTransaction).toHaveBeenCalledWith(
      'challengeXDR',
      'Test SDF Network ; September 2015',
    );
    expect(apiMock.getToken).toHaveBeenCalledWith('signedXDR');
  });

  it('connect() stores JWT in sessionStorage (not localStorage)', async () => {
    await service.connect();

    expect(sessionStorage.getItem('cc_jwt')).toBe('mock.jwt.token');
    expect(localStorage.getItem('cc_jwt')).toBeNull();
  });

  it('connect() sets authState to authenticated and exposes token', async () => {
    await service.connect();

    expect(service.isAuthenticated()).toBe(true);
    expect(service.authState()).toBe('authenticated');
    expect(service.token()).toBe('mock.jwt.token');
  });

  it('connect() sets authState to error on Freighter rejection', async () => {
    (walletMock.signTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('User rejected'),
    );

    await expect(service.connect()).rejects.toThrow('User rejected');

    expect(service.authState()).toBe('error');
    expect(service.authError()).toBe('User rejected');
    expect(service.token()).toBeNull();
  });

  it('connect() does not write to sessionStorage on failure', async () => {
    (walletMock.signTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('User rejected'),
    );

    await expect(service.connect()).rejects.toThrow();
    expect(sessionStorage.getItem('cc_jwt')).toBeNull();
  });

  it('disconnect() clears sessionStorage and resets state', async () => {
    await service.connect();
    expect(service.isAuthenticated()).toBe(true);

    service.disconnect();

    expect(sessionStorage.getItem('cc_jwt')).toBeNull();
    expect(service.token()).toBeNull();
    expect(service.authState()).toBe('unauthenticated');
    expect(walletMock.disconnect).toHaveBeenCalledTimes(1);
  });

  it('clearSession() removes JWT from sessionStorage and resets state', async () => {
    await service.connect();
    service.clearSession();

    expect(sessionStorage.getItem('cc_jwt')).toBeNull();
    expect(service.token()).toBeNull();
    expect(service.isAuthenticated()).toBe(false);
  });

  it('restores authenticated state from sessionStorage on init', () => {
    sessionStorage.setItem('cc_jwt', 'persisted.jwt.token');

    // Re-create the service to simulate page reload
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: StellarWalletService, useValue: walletMock },
        { provide: ApiService, useValue: apiMock },
      ],
    });

    const freshService = TestBed.inject(AuthService);
    expect(freshService.token()).toBe('persisted.jwt.token');
    expect(freshService.isAuthenticated()).toBe(true);
  });

  it('login() is an alias for connect()', async () => {
    await service.login();
    expect(service.isAuthenticated()).toBe(true);
  });

  it('logout() is an alias for disconnect()', async () => {
    await service.connect();
    service.logout();
    expect(service.isAuthenticated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// authInterceptor — JWT attachment
// ---------------------------------------------------------------------------

describe('authInterceptor — JWT attachment', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            token: signal<string | null>('test-jwt-token'),
            isAuthenticated: signal(true),
            clearSession: vi.fn(),
          },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    });

    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    sessionStorage.clear();
  });

  it('attaches Authorization header with Bearer token to outgoing requests', () => {
    http.get('/api/credits').subscribe();

    const req = controller.expectOne('/api/credits');
    expect(req.request.headers.get('Authorization')).toBe('Bearer test-jwt-token');
    req.flush([]);
  });

  it('does not attach Authorization header when token is null', () => {
    TestBed.overrideProvider(AuthService, {
      useValue: {
        token: signal<string | null>(null),
        isAuthenticated: signal(false),
        clearSession: vi.fn(),
      },
    });

    http.get('/api/public').subscribe();
    const req = controller.expectOne('/api/public');
    expect(req.request.headers.get('Authorization')).toBeNull();
    req.flush({});
  });
});

// ---------------------------------------------------------------------------
// authInterceptor — 401 redirect (existing behaviour preserved)
// ---------------------------------------------------------------------------

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

  it('token is null after clearSession is invoked (JWT cleared)', async () => {
    const tokenSignal = signal<string | null>('some-jwt');

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        {
          provide: AuthService,
          useValue: {
            clearSession: () => tokenSignal.set(null),
            token: tokenSignal,
            isAuthenticated: signal(false),
          },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    }).compileComponents();

    const localHttp = TestBed.inject(HttpClient);
    const localController = TestBed.inject(HttpTestingController);

    localHttp.get('/api/credits').subscribe({ error: () => {} });
    localController.expectOne('/api/credits').flush('Unauthorized', {
      status: 401,
      statusText: 'Unauthorized',
    });
    expect(tokenSignal()).toBeNull();
    localController.verify();
  });
});
