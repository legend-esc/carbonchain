import { TestBed } from '@angular/core/testing';
import { OnlineStatusService } from './online-status.service';

describe('OnlineStatusService', () => {
  let service: OnlineStatusService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(OnlineStatusService);
  });

  it('reflects navigator.onLine at construction time', () => {
    expect(service.online()).toBe(navigator.onLine);
  });

  it('flips to false when the window fires an offline event', () => {
    window.dispatchEvent(new Event('offline'));
    expect(service.online()).toBe(false);
  });

  it('flips back to true when the window fires an online event', () => {
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    expect(service.online()).toBe(true);
  });
});
