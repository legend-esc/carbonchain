import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class OnlineStatusService {
  private readonly _online = signal(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  readonly online = this._online.asReadonly();

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => this._online.set(true));
    window.addEventListener('offline', () => this._online.set(false));
  }
}
