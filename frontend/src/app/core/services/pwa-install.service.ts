import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/**
 * Service to manage PWA installation prompt.
 * Listens for the beforeinstallprompt event and provides methods to trigger installation.
 */
@Injectable({
  providedIn: 'root',
})
export class PwaInstallService {
  private deferredPrompt: any = null;
  private readonly showInstallPrompt$ = new BehaviorSubject<boolean>(false);
  private readonly isInstalled$ = new BehaviorSubject<boolean>(false);

  readonly showInstallPrompt = this.showInstallPrompt$.asObservable();
  readonly isInstalled = this.isInstalled$.asObservable();

  initialize(): void {
    // Check if app is already installed (standalone mode)
    if (this.isRunningStandalone()) {
      this.isInstalled$.next(true);
      this.showInstallPrompt$.next(false);
      return;
    }

    // Listen for beforeinstallprompt event
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      // Prevent the default browser install prompt
      e.preventDefault();

      // Store the event for later use
      this.deferredPrompt = e;

      // Show custom install prompt
      this.showInstallPrompt$.next(true);

      console.log('[PWA] Install prompt available');
    });

    // Listen for app installed event
    window.addEventListener('appinstalled', () => {
      console.log('[PWA] App installed successfully');
      this.isInstalled$.next(true);
      this.showInstallPrompt$.next(false);
      this.deferredPrompt = null;
    });
  }

  /**
   * Trigger the install prompt.
   * Returns true if the user accepted, false if declined.
   */
  async promptInstall(): Promise<boolean> {
    if (!this.deferredPrompt) {
      console.warn('[PWA] No install prompt available');
      return false;
    }

    // Show the browser's install prompt
    this.deferredPrompt.prompt();

    // Wait for the user's response
    const { outcome } = await this.deferredPrompt.userChoice;

    console.log(`[PWA] User choice: ${outcome}`);

    if (outcome === 'accepted') {
      this.showInstallPrompt$.next(false);
      this.deferredPrompt = null;
      return true;
    }

    return false;
  }

  /**
   * Dismiss the install prompt banner.
   * The prompt won't be shown again until the page is reloaded.
   */
  dismissPrompt(): void {
    this.showInstallPrompt$.next(false);
  }

  /**
   * Check if the app is running in standalone mode (already installed).
   */
  private isRunningStandalone(): boolean {
    // Check if running as PWA
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true || // iOS Safari
      document.referrer.includes('android-app://') // Android TWA
    );
  }

  /**
   * Check if installation is supported by the browser.
   */
  isInstallSupported(): boolean {
    return 'BeforeInstallPromptEvent' in window || this.isRunningStandalone();
  }
}
