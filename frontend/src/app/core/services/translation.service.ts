import { Injectable, signal } from '@angular/core';
import * as en from '../../../assets/i18n/en.json';

export type Locale = 'en' | 'es' | 'fr';

const STORAGE_KEY = 'locale';
const ALL_LOCALES: Locale[] = ['en', 'es', 'fr'];
const DEFAULT_LOCALE: Locale = 'en';

/**
 * English ships in the application bundle so that translation keys resolve
 * even before `init()` has fetched the locale files (and so unit tests and
 * offline sessions never render a raw key). Non-default locales are loaded
 * asynchronously from `/assets/i18n/<locale>.json`.
 */
const BUNDLED_EN: Record<string, string> = en as Record<string, string>;

/** Replaces `{name}` placeholders with the matching parameter value. */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

@Injectable({ providedIn: 'root' })
export class TranslationService {
  private cache = new Map<Locale, Record<string, string>>();
  private translations: Record<string, string> = { ...BUNDLED_EN };
  private readonly _locale = signal<Locale>(this.resolveInitialLocale());

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
        try {
          const res = await fetch(`/assets/i18n/${locale}.json`);
          if (!res.ok) {
            throw new Error(`Failed to load locale "${locale}" (${res.status})`);
          }
          this.cache.set(locale, (await res.json()) as Record<string, string>);
        } catch {
          // Keep the bundled English fallback for this locale so a failed
          // fetch never renders raw keys.
          this.cache.set(locale, locale === DEFAULT_LOCALE ? { ...BUNDLED_EN } : {});
        }
      }),
    );
    this.translations = this.cache.get(current) ?? { ...BUNDLED_EN };
  }

  setLocale(locale: Locale): void {
    this.translations =
      this.cache.get(locale) ?? (locale === DEFAULT_LOCALE ? { ...BUNDLED_EN } : {});
    this._locale.set(locale);
    localStorage.setItem(STORAGE_KEY, locale);
  }

  /** Resolves a key for the active locale, falling back to English then the key. */
  t(key: string, params?: Record<string, string | number>): string {
    const template = this.translations[key] ?? BUNDLED_EN[key] ?? key;
    return interpolate(template, params);
  }

  private resolveInitialLocale(): Locale {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return ALL_LOCALES.includes(stored as Locale) ? (stored as Locale) : DEFAULT_LOCALE;
  }
}
