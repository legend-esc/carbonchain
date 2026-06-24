import { TestBed } from '@angular/core/testing';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  let service: ToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ToastService);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the service', () => {
    expect(service).toBeTruthy();
  });

  it('starts with no toasts', () => {
    expect(service.toasts()).toHaveLength(0);
  });

  it('show() adds a toast with the given message and type', () => {
    service.show('Something went wrong', 'error');
    const toasts = service.toasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('Something went wrong');
    expect(toasts[0].type).toBe('error');
  });

  it('show() defaults to error type', () => {
    service.show('oops');
    expect(service.toasts()[0].type).toBe('error');
  });

  it('show() assigns unique ids to multiple toasts', () => {
    service.show('first');
    service.show('second');
    const ids = service.toasts().map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('dismiss() removes the toast with the given id', () => {
    service.show('msg1');
    service.show('msg2');
    const id = service.toasts()[0].id;
    service.dismiss(id);
    expect(service.toasts()).toHaveLength(1);
    expect(service.toasts()[0].message).toBe('msg2');
  });

  it('auto-dismisses after the specified duration', () => {
    service.show('auto', 'info', 3000);
    expect(service.toasts()).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(service.toasts()).toHaveLength(0);
  });

  it('does not dismiss before the duration elapses', () => {
    service.show('still here', 'success', 5000);
    vi.advanceTimersByTime(4999);
    expect(service.toasts()).toHaveLength(1);
  });
});
