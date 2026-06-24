import { Injectable, signal } from '@angular/core';

export type Locale = 'en' | 'es' | 'fr';

const STORAGE_KEY = 'locale';
const ALL_LOCALES: Locale[] = ['en', 'es', 'fr'];

@Injectable({ providedIn: 'root' })
export class TranslationService {
  private cache = new Map<Locale, Record<string, string>>();
  private translations: Record<string, string> = {};
  private readonly _locale = signal<Locale>((localStorage.getItem(STORAGE_KEY) as Locale) ?? 'en');

  readonly locale = this._locale.asReadonly();
  readonly locales: { code: Locale; label: string }[] = [
    { code: 'en', label: 'EN' },
    { code: 'es', label: 'ES' },
    { code: 'fr', label: 'FR' },
  ];

  async init(): Promise<void> {
    const current = this._locale();
    await Promise.all(
      ALL_LOCALES.map(async (locale) => {
        const res = await fetch(`/assets/i18n/${locale}.json`);
        this.cache.set(locale, await res.json());
      }),
    );
    this.translations = this.cache.get(current)!;
  }

  setLocale(locale: Locale): void {
    this.translations = this.cache.get(locale) ?? this.translations;
    this._locale.set(locale);
    localStorage.setItem(STORAGE_KEY, locale);
  }

  t(key: string): string {
    return this.translations[key] ?? key;
  }
}
