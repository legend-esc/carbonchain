import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminVerifiersComponent } from './admin-verifiers.component';
import { ApiService, VerifierInfo } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { ToastService } from '../core/services/toast.service';
import { Router } from '@angular/router';
import { TestBed as TB } from '@angular/core/testing';
import { adminGuard } from '../core/guards/admin.guard';

const MOCK_TOKEN = 'header.eyJyb2xlIjoiYWRtaW4ifQ.sig'; // role: admin

const mockVerifier: VerifierInfo = { address: 'GVERIFIER1234567890ABCDEF' };

const mockStats = { totalCredits: 10, totalRetirements: 2, activeVerifiers: 1 };

describe('AdminVerifiersComponent', () => {
  let fixture: ComponentFixture<AdminVerifiersComponent>;
  let component: AdminVerifiersComponent;
  let apiSpy: ReturnType<typeof createApiSpy>;
  let authSpy: ReturnType<typeof createAuthSpy>;
  let toastSpy: ReturnType<typeof createToastSpy>;

  function createApiSpy() {
    return {
      listVerifiers: vi.fn().mockReturnValue(of([])),
      getAdminStats: vi.fn().mockReturnValue(of(mockStats)),
      registerVerifier: vi.fn(),
      suspendVerifier: vi.fn(),
      configureVerifier: vi.fn(),
    };
  }

  function createAuthSpy() {
    return {
      token: () => MOCK_TOKEN,
      isAuthenticated: () => true,
    };
  }

  function createToastSpy() {
    return { show: vi.fn() };
  }

  beforeEach(async () => {
    apiSpy = createApiSpy();
    authSpy = createAuthSpy() as any;
    toastSpy = createToastSpy();

    await TestBed.configureTestingModule({
      imports: [AdminVerifiersComponent],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: AuthService, useValue: authSpy },
        { provide: ToastService, useValue: toastSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminVerifiersComponent);
    component = fixture.componentInstance;
  });

  // ── List ──────────────────────────────────────────────────────────────────

  it('shows empty state when no verifiers', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No verifiers registered');
  });

  it('renders verifiers in a table', async () => {
    apiSpy.listVerifiers.mockReturnValue(of([mockVerifier]));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr') as NodeList;
    expect(rows.length).toBe(1);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(mockVerifier.address);
  });

  it('displays active verifier count from stats', async () => {
    apiSpy.listVerifiers.mockReturnValue(of([mockVerifier]));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('1');
  });

  it('shows error message when list API fails', async () => {
    apiSpy.listVerifiers.mockReturnValue(throwError(() => new Error('Network error')));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Network error');
  });

  // ── Register ──────────────────────────────────────────────────────────────

  it('opens register modal when button clicked', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('button.btn-primary') as HTMLButtonElement;
    btn.click();
    fixture.detectChanges();

    const modal = fixture.nativeElement.querySelector(
      '[aria-labelledby="register-title"]',
    ) as HTMLElement;
    expect(modal).toBeTruthy();
  });

  it('calls registerVerifier and reloads on submit', async () => {
    apiSpy.listVerifiers.mockReturnValue(of([mockVerifier]));
    apiSpy.registerVerifier.mockReturnValue(of({ registered: true, address: 'GNEW' }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.openRegister();
    (component as any).registerAddressValue = 'GNEWADDRESS';
    fixture.detectChanges();

    await component.submitRegister();

    expect(apiSpy.registerVerifier).toHaveBeenCalledWith('GNEWADDRESS', MOCK_TOKEN);
    expect(toastSpy.show).toHaveBeenCalledWith('Verifier registered successfully.', 'success');
  });

  it('shows toast error when registerVerifier fails', async () => {
    apiSpy.registerVerifier.mockReturnValue(throwError(() => new Error('Already exists')));
    fixture.detectChanges();
    await fixture.whenStable();

    component.openRegister();
    (component as any).registerAddressValue = 'GBAD';
    await component.submitRegister();

    expect(toastSpy.show).toHaveBeenCalledWith('Already exists', 'error');
  });

  it('does not call registerVerifier when address is empty', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    component.openRegister();
    (component as any).registerAddressValue = '   ';
    await component.submitRegister();

    expect(apiSpy.registerVerifier).not.toHaveBeenCalled();
  });

  it('closes register modal on cancel', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    component.openRegister();
    fixture.detectChanges();
    expect((component as any)['showRegister']()).toBe(true);

    component.closeRegister();
    expect((component as any)['showRegister']()).toBe(false);
  });

  // ── Configure ─────────────────────────────────────────────────────────────

  it('opens configure modal with correct verifier address', async () => {
    apiSpy.listVerifiers.mockReturnValue(of([mockVerifier]));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.openConfigure(mockVerifier.address);
    fixture.detectChanges();

    const modal = fixture.nativeElement.querySelector(
      '[aria-labelledby="configure-title"]',
    ) as HTMLElement;
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain(mockVerifier.address);
  });

  it('toggles methodology selection', () => {
    component.openConfigure('GADDR');
    component.toggleMethodology('Verra VCS');
    expect(component['selectedMethodologies']()).toContain('Verra VCS');

    component.toggleMethodology('Verra VCS');
    expect(component['selectedMethodologies']()).not.toContain('Verra VCS');
  });

  it('toggles geography selection', () => {
    component.openConfigure('GADDR');
    component.toggleGeography('Africa');
    expect(component['selectedGeographies']()).toContain('Africa');

    component.toggleGeography('Africa');
    expect(component['selectedGeographies']()).not.toContain('Africa');
  });

  it('calls configureVerifier on submit and shows success toast', async () => {
    apiSpy.configureVerifier.mockReturnValue(
      of({ configured: true, verifierId: mockVerifier.address }),
    );
    component.openConfigure(mockVerifier.address);
    component.toggleMethodology('Verra VCS');
    component.toggleGeography('Africa');

    await component.submitConfigure();

    expect(apiSpy.configureVerifier).toHaveBeenCalledWith(
      mockVerifier.address,
      { methodologies: ['Verra VCS'], geographies: ['Africa'] },
      MOCK_TOKEN,
    );
    expect(toastSpy.show).toHaveBeenCalledWith('Capabilities saved.', 'success');
    expect(component['configuringVerifier']()).toBeNull();
  });

  it('shows toast error when configureVerifier fails', async () => {
    apiSpy.configureVerifier.mockReturnValue(throwError(() => new Error('Contract error')));
    component.openConfigure(mockVerifier.address);

    await component.submitConfigure();

    expect(toastSpy.show).toHaveBeenCalledWith('Contract error', 'error');
  });

  it('closes configure modal on cancel', () => {
    component.openConfigure(mockVerifier.address);
    expect(component['configuringVerifier']()).toBe(mockVerifier.address);

    component.closeConfigure();
    expect(component['configuringVerifier']()).toBeNull();
  });

  // ── Suspend ───────────────────────────────────────────────────────────────

  it('opens suspend confirmation with correct address', async () => {
    apiSpy.listVerifiers.mockReturnValue(of([mockVerifier]));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.openSuspend(mockVerifier.address);
    fixture.detectChanges();

    const modal = fixture.nativeElement.querySelector(
      '[aria-labelledby="suspend-title"]',
    ) as HTMLElement;
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain(mockVerifier.address);
  });

  it('calls suspendVerifier on confirm and reloads', async () => {
    apiSpy.listVerifiers.mockReturnValue(of([]));
    apiSpy.suspendVerifier.mockReturnValue(of({ suspended: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    component.openSuspend(mockVerifier.address);
    await component.confirmSuspend();

    expect(apiSpy.suspendVerifier).toHaveBeenCalledWith(mockVerifier.address, MOCK_TOKEN);
    expect(toastSpy.show).toHaveBeenCalledWith('Verifier suspended.', 'success');
    expect(component['suspendingVerifier']()).toBeNull();
  });

  it('shows toast error when suspendVerifier fails', async () => {
    apiSpy.suspendVerifier.mockReturnValue(throwError(() => new Error('Not found')));
    component.openSuspend(mockVerifier.address);

    await component.confirmSuspend();

    expect(toastSpy.show).toHaveBeenCalledWith('Not found', 'error');
  });

  it('closes suspend modal on cancel', () => {
    component.openSuspend(mockVerifier.address);
    expect(component['suspendingVerifier']()).toBe(mockVerifier.address);

    component.closeSuspend();
    expect(component['suspendingVerifier']()).toBeNull();
  });
});

// ── Admin Guard redirect ──────────────────────────────────────────────────────

describe('adminGuard', () => {
  function runGuard(token: string | null, isAuthenticated: boolean) {
    const authSpy = { token: () => token, isAuthenticated: () => isAuthenticated };
    const routerSpy = { createUrlTree: vi.fn((path: string[]) => ({ path })) };

    TB.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: authSpy },
        { provide: Router, useValue: routerSpy },
      ],
    });

    const result = TB.runInInjectionContext(() => adminGuard({} as any, {} as any));
    return { result, routerSpy };
  }

  it('redirects to /dashboard when authenticated but not admin', () => {
    // non-admin token: payload role = "user"
    const nonAdminToken = 'header.' + btoa(JSON.stringify({ role: 'user' })) + '.sig';
    const { result, routerSpy } = runGuard(nonAdminToken, true);
    expect(routerSpy.createUrlTree).toHaveBeenCalledWith(['/dashboard']);
    expect(result).toEqual({ path: ['/dashboard'] });
  });

  it('allows access when authenticated and role is admin', () => {
    const adminToken = 'header.' + btoa(JSON.stringify({ role: 'admin' })) + '.sig';
    const { result } = runGuard(adminToken, true);
    expect(result).toBe(true);
  });

  it('redirects to /connect-wallet when not authenticated', () => {
    const { result, routerSpy } = runGuard(null, false);
    expect(routerSpy.createUrlTree).toHaveBeenCalledWith(['/connect-wallet']);
    expect(result).toEqual({ path: ['/connect-wallet'] });
  });
});
