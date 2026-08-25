import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminComponent } from './admin.component';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { ToastService } from '../core/services/toast.service';

const MOCK_TOKEN = 'header.eyJyb2xlIjoiYWRtaW4ifQ.sig';

describe('AdminComponent', () => {
  let fixture: ComponentFixture<AdminComponent>;
  let component: AdminComponent;
  let apiSpy: ReturnType<typeof createApiSpy>;
  let toastSpy: ReturnType<typeof createToastSpy>;

  function createApiSpy() {
    return {
      getAdminStats: vi
        .fn()
        .mockReturnValue(
          of({ totalCredits: 0, totalRetirements: 0, activeVerifiers: 3, paused: false }),
        ),
      registerMethodology: vi.fn(),
      getAdminNonce: vi.fn().mockReturnValue(of({ address: 'GADMIN', nonce: 0 })),
      setRequiredApprovals: vi.fn(),
      pauseContract: vi.fn().mockReturnValue(of({ paused: true })),
      unpauseContract: vi.fn().mockReturnValue(of({ paused: false })),
      // AdminVerifiersComponent uses these:
      listVerifiers: vi.fn().mockReturnValue(of([])),
      registerVerifier: vi.fn(),
      suspendVerifier: vi.fn(),
      configureVerifier: vi.fn(),
    };
  }

  function createToastSpy() {
    return { show: vi.fn() };
  }

  beforeEach(async () => {
    apiSpy = createApiSpy();
    toastSpy = createToastSpy();

    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        {
          provide: AuthService,
          useValue: { token: () => MOCK_TOKEN, isAuthenticated: () => true },
        },
        { provide: ToastService, useValue: toastSpy },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminComponent);
    component = fixture.componentInstance;
  });

  // ── Render ────────────────────────────────────────────────────────────────

  it('renders the Admin Panel heading', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Admin Panel');
  });

  it('renders the Methodology Registration section', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Methodology Registration');
  });

  it('renders the Required Approvals section', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Required Approvals');
  });

  it('renders the Contract Pause section', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Contract Pause');
  });

  // ── Methodology registration ───────────────────────────────────────────────

  it('calls registerMethodology and shows toast on success', async () => {
    apiSpy.registerMethodology.mockReturnValue(
      of({ registered: true, name: 'VCS', description: 'Verified Carbon Standard' }),
    );
    fixture.detectChanges();
    await fixture.whenStable();

    (component as any)['methodologyName'] = 'VCS';
    (component as any)['methodologyDescription'] = 'Verified Carbon Standard';
    await (component as any).submitMethodology();

    expect(apiSpy.registerMethodology).toHaveBeenCalledWith(
      'VCS',
      'Verified Carbon Standard',
      MOCK_TOKEN,
    );
    expect(toastSpy.show).toHaveBeenCalledWith('Methodology "VCS" registered.', 'success');
  });

  it('does not call registerMethodology when name is empty', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    (component as any)['methodologyName'] = '   ';
    (component as any)['methodologyDescription'] = 'Some description';
    await (component as any).submitMethodology();

    expect(apiSpy.registerMethodology).not.toHaveBeenCalled();
  });

  it('sets error when registerMethodology fails', async () => {
    apiSpy.registerMethodology.mockReturnValue(throwError(() => new Error('Already registered')));
    fixture.detectChanges();
    await fixture.whenStable();

    (component as any)['methodologyName'] = 'VCS';
    (component as any)['methodologyDescription'] = 'desc';
    await (component as any).submitMethodology();

    expect((component as any)['methodologyError']()).toBe('Already registered');
  });

  // ── Required approvals slider ─────────────────────────────────────────────

  it('updates requiredApprovals on slider change', () => {
    const event = { target: { value: '3' } } as unknown as Event;
    (component as any).onSliderChange(event);
    expect((component as any)['requiredApprovals']()).toBe(3);
  });

  it('calls setRequiredApprovals and shows toast on save', async () => {
    apiSpy.setRequiredApprovals.mockReturnValue(of({ requiredApprovals: 2 }));
    fixture.detectChanges();
    await fixture.whenStable();

    (component as any)['requiredApprovals'].set(2);
    await (component as any).saveRequiredApprovals();

    expect(apiSpy.setRequiredApprovals).toHaveBeenCalledWith(2, MOCK_TOKEN);
    expect(toastSpy.show).toHaveBeenCalledWith('Required approvals set to 2.', 'success');
  });

  it('sets error when setRequiredApprovals fails', async () => {
    apiSpy.setRequiredApprovals.mockReturnValue(throwError(() => new Error('Threshold too high')));
    fixture.detectChanges();
    await fixture.whenStable();

    await (component as any).saveRequiredApprovals();

    expect((component as any)['approvalsError']()).toBe('Threshold too high');
  });

  // ── Pause confirmation modal ──────────────────────────────────────────────

  it('opens pause confirmation modal', () => {
    (component as any).openPauseConfirm();
    expect((component as any)['showPauseConfirm']()).toBe(true);
  });

  it('closes pause confirmation modal on cancel', () => {
    (component as any).openPauseConfirm();
    (component as any).closePauseConfirm();
    expect((component as any)['showPauseConfirm']()).toBe(false);
  });

  it('calls pauseContract API on confirm and updates state', async () => {
    expect((component as any)['contractPaused']()).toBe(false);
    (component as any).openPauseConfirm();
    await (component as any).confirmPause();
    expect(apiSpy.pauseContract).toHaveBeenCalledWith(MOCK_TOKEN);
    expect((component as any)['contractPaused']()).toBe(true);
    expect(toastSpy.show).toHaveBeenCalled();
    expect((component as any)['showPauseConfirm']()).toBe(false);
  });

  it('calls unpauseContract API when already paused', async () => {
    (component as any)['contractPaused'].set(true);
    (component as any).openPauseConfirm();
    await (component as any).confirmPause();
    expect(apiSpy.unpauseContract).toHaveBeenCalledWith(MOCK_TOKEN);
    expect((component as any)['contractPaused']()).toBe(false);
    expect(toastSpy.show).toHaveBeenCalledWith('Contract unpaused. Operations resumed.', 'success');
  });

  it('sets error when pauseContract fails', async () => {
    apiSpy.pauseContract.mockReturnValue(throwError(() => new Error('Contract call failed')));
    (component as any).openPauseConfirm();
    await (component as any).confirmPause();
    expect((component as any)['pauseError']()).toBe('Contract call failed');
  });

  it('loads maxApprovals from admin stats on init', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    // stats.activeVerifiers = 3, so maxApprovals should be 3
    expect((component as any)['maxApprovals']()).toBe(3);
  });
});
