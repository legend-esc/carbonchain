/**
 * Issue #1333 — OfflineService
 *
 * Thin façade over OnlineStatusService that adds a brief "Connection restored"
 * window so the banner can display a positive confirmation before it dismisses.
 * Components should inject OfflineService rather than OnlineStatusService
 * directly when they need the banner lifecycle.
 */
import { Injectable, signal, computed, inject } from '@angular/core';
import { OnlineStatusService } from '../core/services/online-status.service';

/** How long (ms) the "Connection restored" message stays visible. */
export const RESTORED_LINGER_MS = 2500;

export type BannerState = 'offline' | 'restored' | 'hidden';

@Injectable({ providedIn: 'root' })
export class OfflineService {
  private readonly onlineStatus = inject(OnlineStatusService);

  /** Internal banner phase. */
  private readonly _state = signal<BannerState>(this.onlineStatus.online() ? 'hidden' : 'offline');

  /** Public read-only state consumed by OfflineBannerComponent. */
  readonly state = this._state.asReadonly();

  /** True while the app has no connectivity (guards submit buttons). */
  readonly isOffline = computed(() => this._state() === 'offline');

  /** True when the banner should be rendered at all. */
  readonly bannerVisible = computed(() => this._state() !== 'hidden');

  private _lingerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;

    window.addEventListener('offline', () => {
      if (this._lingerTimer !== null) {
        clearTimeout(this._lingerTimer);
        this._lingerTimer = null;
      }
      this._state.set('offline');
    });

    window.addEventListener('online', () => {
      this._state.set('restored');
      this._lingerTimer = setTimeout(() => {
        this._state.set('hidden');
        this._lingerTimer = null;
      }, RESTORED_LINGER_MS);
    });
  }
}
