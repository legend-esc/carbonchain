/**
 * Issue #1336 — unit tests for ToastContainerComponent and ToastService enhancements.
 *
 * Covers:
 *  - show / dismiss / queuing behaviour
 *  - auto-dismiss after configured duration
 *  - StellarExpert link when txHash is present
 *  - action button/link rendering
 *  - warning type
 *  - accessible role attributes
 */
import { TestBed, ComponentFixture, fakeAsync, tick } from '@angular/core/testing';
import { ToastContainerComponent } from './toast-container.component';
import { ToastService, STELLAR_EXPERT_TX_BASE } from '../services/toast.service';

describe('ToastService (enhanced)', () => {
  let service: ToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ToastService);
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('showWarning() adds a warning toast', () => {
    service.showWarning('low balance');
    expect(service.toasts()[0].type).toBe('warning');
  });

  it('showTx() adds a success toast with txHash', () => {
    service.showTx('Retired successfully', 'abc123');
    const toast = service.toasts()[0];
    expect(toast.type).toBe('success');
    expect(toast.txHash).toBe('abc123');
  });

  it('showTx() respects the provided type', () => {
    service.showTx('Something', 'hash456', 'info');
    expect(service.toasts()[0].type).toBe('info');
  });

  it('show() with txHash stores the hash on the toast', () => {
    service.show('tx done', 'success', 5000, { txHash: 'hash789' });
    expect(service.toasts()[0].txHash).toBe('hash789');
  });

  it('show() with action stores the action on the toast', () => {
    const action = { label: 'Undo', onClick: vi.fn() };
    service.show('item deleted', 'info', 5000, { action });
    expect(service.toasts()[0].action).toBe(action);
  });

  it('queueing — multiple toasts accumulate in order', () => {
    service.show('first', 'info');
    service.show('second', 'success');
    service.show('third', 'error');
    const msgs = service.toasts().map((t) => t.message);
    expect(msgs).toEqual(['first', 'second', 'third']);
  });

  it('dismiss() removes only the targeted toast', () => {
    service.show('a');
    service.show('b');
    const id = service.toasts()[0].id;
    service.dismiss(id);
    expect(service.toasts()).toHaveLength(1);
    expect(service.toasts()[0].message).toBe('b');
  });

  it('auto-dismisses after the specified duration', () => {
    service.show('auto', 'info', 2000);
    vi.advanceTimersByTime(2000);
    expect(service.toasts()).toHaveLength(0);
  });

  it('does not auto-dismiss before the duration elapses', () => {
    service.show('still here', 'success', 5000);
    vi.advanceTimersByTime(4999);
    expect(service.toasts()).toHaveLength(1);
  });
});

describe('ToastContainerComponent', () => {
  let fixture: ComponentFixture<ToastContainerComponent>;
  let service: ToastService;

  const render = () => fixture.detectChanges();

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToastContainerComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ToastContainerComponent);
    service = TestBed.inject(ToastService);
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it('renders nothing when there are no toasts', () => {
    render();
    const toasts = fixture.nativeElement.querySelectorAll('.toast');
    expect(toasts.length).toBe(0);
  });

  it('renders one toast per queued item', () => {
    service.show('one', 'info');
    service.show('two', 'success');
    render();
    expect(fixture.nativeElement.querySelectorAll('.toast').length).toBe(2);
  });

  it('applies the correct type class', () => {
    service.showWarning('careful');
    render();
    const toast: HTMLElement = fixture.nativeElement.querySelector('.toast');
    expect(toast.classList).toContain('toast--warning');
  });

  it('error toasts have role=alert', () => {
    service.showError('boom');
    render();
    const toast: HTMLElement = fixture.nativeElement.querySelector('.toast');
    expect(toast.getAttribute('role')).toBe('alert');
  });

  it('success toasts have role=status', () => {
    service.showSuccess('done');
    render();
    const toast: HTMLElement = fixture.nativeElement.querySelector('.toast');
    expect(toast.getAttribute('role')).toBe('status');
  });

  it('renders a StellarExpert link when txHash is present', () => {
    service.showTx('Retired', 'hash001');
    render();
    const link: HTMLAnchorElement = fixture.nativeElement.querySelector('a.toast__action-link');
    expect(link).not.toBeNull();
    expect(link.href).toContain(STELLAR_EXPERT_TX_BASE);
    expect(link.href).toContain('hash001');
  });

  it('renders an action link when action.href is provided', () => {
    service.show('note', 'info', 5000, {
      action: { label: 'Open', href: 'https://example.com' },
    });
    render();
    const links: NodeListOf<HTMLAnchorElement> =
      fixture.nativeElement.querySelectorAll('a.toast__action-link');
    const labels = Array.from(links).map((l) => l.textContent?.trim());
    expect(labels).toContain('Open');
  });

  it('renders an action button when action.onClick is provided', () => {
    const onClick = vi.fn();
    service.show('deletable', 'info', 5000, {
      action: { label: 'Undo', onClick },
    });
    render();
    const btn: HTMLButtonElement = fixture.nativeElement.querySelector('button.toast__action-btn');
    expect(btn).not.toBeNull();
    btn.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('dismiss button removes the toast from the DOM', () => {
    service.show('temporary', 'success');
    render();
    const closeBtn: HTMLButtonElement =
      fixture.nativeElement.querySelector('.toast__close');
    closeBtn.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.toast').length).toBe(0);
  });
});
