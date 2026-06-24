import { Injectable, signal, computed } from '@angular/core';

const STORAGE_KEY = 'theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _dark = signal<boolean>(this.loadPreference());

  readonly isDark = this._dark.asReadonly();
  readonly icon = computed(() => (this._dark() ? '☀️' : '🌙'));

  toggle(): void {
    const next = !this._dark();
    this._dark.set(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
  }

  private loadPreference(): boolean {
    const stored = localStorage.getItem(STORAGE_KEY);
    const dark = stored
      ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', dark);
    return dark;
  }
}
