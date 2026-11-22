/**
 * Issue #1333 — unit tests for OfflineBannerComponent and OfflineService.
 *
 * Uses window online/offline events to simulate navigator.onLine toggles,
 * per the acceptance criteria.  Uses vi.useFakeTimers() (the vitest pattern
 * adopted across this codebase) instead of Angular's fakeAsync/tick, which
 * requires zone-testing.js unavailable under vitest.
 */
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { OfflineBannerComponent } from './offline-banner.component';
import { OfflineService, RESTORED_LINGER_MS } from './offline.service';
import { OnlineStatusService } from '../core/services/online-status.service';
import { signal } from '@angular/core';

// ---------------------------------------------------------------------------
// OfflineService
// ---------------------------------------------------------------------------

describe('OfflineService', () => {
  let service: OfflineService;
  let onlineSignal: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    onlineSignal = signal(true);

    TestBed.configureTestingModule({
      providers: [
        OfflineService,
        { provide: OnlineStatusService, useValue: { online: onlineSignal } },
      ],
    });
    service = TestBed.inject(OfflineService);
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('starts hidden when initially online', () => {
    expect(service.state()).toBe('hidden');
    expect(service.bannerVisible()).toBe(false);
    expect(service.isOffline()).toBe(false);
  });

  it('transitions to offline state on window offline event', () => {
    window.dispatchEvent(new Event('offline'));
    expect(service.state()).toBe('offline');
    expect(service.isOffline()).toBe(true);
    expect(service.bannerVisible()).toBe(true);
  });

  it('transitions to restored state on window online event', () => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(service.state()).toBe('restored');
    expect(service.isOffline()).toBe(false);
    expect(service.bannerVisible()).toBe(true);
  });

  it('hides banner after the linger period following reconnection', () => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(service.state()).toBe('restored');
    vi.advanceTimersByTime(RESTORED_LINGER_MS);
    expect(service.state()).toBe('hidden');
    expect(service.bannerVisible()).toBe(false);
  });

  it('cancels linger timer when going offline again during restored phase', () => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(RESTORED_LINGER_MS / 2);
    // Go offline again before linger expires
    window.dispatchEvent(new Event('offline'));
    expect(service.state()).toBe('offline');
    // Advancing past original linger deadline should not change state
    vi.advanceTimersByTime(RESTORED_LINGER_MS);
    expect(service.state()).toBe('offline');
  });
});

// ---------------------------------------------------------------------------
// OfflineBannerComponent
// ---------------------------------------------------------------------------

describe('OfflineBannerComponent', () => {
  let fixture: ComponentFixture<OfflineBannerComponent>;
  let offlineService: OfflineService;

  beforeEach(async () => {
    // Start with a fresh OfflineService whose OnlineStatusService says online
    const onlineSignal = signal(true);

    await TestBed.configureTestingModule({
      imports: [OfflineBannerComponent],
      providers: [
        OfflineService,
        { provide: OnlineStatusService, useValue: { online: onlineSignal } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(OfflineBannerComponent);
    offlineService = TestBed.inject(OfflineService);
    fixture.detectChanges();
  });

  it('renders no banner when online', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.offline-banner')).toBeNull();
  });

  it('shows the offline banner when the network goes offline', () => {
    window.dispatchEvent(new Event('offline'));
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('.offline-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.classList).toContain('offline-banner--offline');
    expect(banner.textContent).toContain('offline');
  });

  it('switches to the restored variant when connectivity returns', () => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('.offline-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.classList).toContain('offline-banner--restored');
    expect(banner.textContent).toContain('restored');
  });

  it('banner has role=status for accessible live region', () => {
    window.dispatchEvent(new Event('offline'));
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('.offline-banner') as HTMLElement;
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
  });

  it('isOffline() is true while banner shows offline state', () => {
    window.dispatchEvent(new Event('offline'));
    expect(offlineService.isOffline()).toBe(true);
  });

  it('isOffline() is false in restored state', () => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(offlineService.isOffline()).toBe(false);
  });
});
