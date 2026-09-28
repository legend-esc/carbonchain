import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * #961 — guards i18n coverage in the test suite (in addition to the
 * `npm run i18n:check` build-time lint). Every locale must carry the same
 * keys as the reference locale, and no key may resolve to an empty string.
 */
const I18N_DIR = join(process.cwd(), 'src', 'assets', 'i18n');
const APP_DIR = join(process.cwd(), 'src', 'app');
const LOCALES = ['en', 'es', 'fr'] as const;
const REFERENCE = 'en';

function loadCatalogues(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const locale of LOCALES) {
    out[locale] = JSON.parse(readFileSync(join(I18N_DIR, `${locale}.json`), 'utf8'));
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  const patterns = [
    /'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'\s*\|\s*translate/g,
    /\bt\(\s*'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'/g,
  ];
  for (const file of walk(APP_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const re of patterns) {
      for (const m of source.matchAll(re)) keys.add(m[1]);
    }
  }
  return keys;
}

const catalogues = loadCatalogues();
const referenceKeys = Object.keys(catalogues[REFERENCE]);

describe('i18n coverage (#961)', () => {
  it('loads a catalogue for every active locale', () => {
    expect(Object.keys(catalogues).sort()).toEqual([...LOCALES].sort());
  });

  it('has an identical key set in every locale', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(catalogues[locale]).sort(), `locale ${locale}`).toEqual(
        [...referenceKeys].sort(),
      );
    }
  });

  it('has no empty or non-string values', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(catalogues[locale])) {
        expect(typeof value, `${locale}.${key}`).toBe('string');
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('resolves every key used in a template in every locale', () => {
    const missing: string[] = [];
    for (const key of usedKeys()) {
      for (const locale of LOCALES) {
        if (!(key in catalogues[locale])) missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has no duplicate keys in the raw JSON', () => {
    for (const locale of LOCALES) {
      const raw = readFileSync(join(I18N_DIR, `${locale}.json`), 'utf8');
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const m of raw.matchAll(/"((?:[^"\\]|\\.)+)"\s*:/g)) {
        if (seen.has(m[1])) dupes.push(m[1]);
        seen.add(m[1]);
      }
      expect(dupes, `locale ${locale}`).toEqual([]);
    }
  });
});
