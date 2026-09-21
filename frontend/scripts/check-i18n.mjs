#!/usr/bin/env node
/**
 * Build-time i18n extraction + missing-key lint (issue #961).
 *
 * The frontend uses a small hand-rolled `translate` pipe / `TranslationService`
 * instead of `@ngx-translate`, so `ngx-translate-extract` cannot see our keys.
 * This script performs the equivalent guard:
 *
 *   1. Extracts every translation key referenced from `src/app/**` templates and
 *      TypeScript (`'key' | translate` and `t('key')` / `i18n.t('key')`).
 *   2. Verifies each referenced key exists in the canonical English catalog.
 *   3. Verifies every active locale (en/es/fr) defines the exact same key set
 *      with non-empty values and matching `{placeholder}` tokens.
 *
 * Exits non-zero on any gap, which fails `npm run build` (via `prebuild`) and CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dirname, '..');
const srcRoot = join(frontendRoot, 'src');
const appRoot = join(srcRoot, 'app');
const i18nDir = join(srcRoot, 'assets', 'i18n');

const DEFAULT_LOCALE = 'en';
const ACTIVE_LOCALES = ['en', 'es', 'fr'];

/** Matches `'some.key' | translate` including whitespace/newlines. */
const PIPE_KEY_RE = /['"`]([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)['"`]\s*\|\s*translate\b/g;
/** Matches `.t('some.key')` and bare `t('some.key')` service calls. */
const CALL_KEY_RE = /(?:^|[^A-Za-z0-9_])t\(\s*['"`]([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)['"`]/g;
/**
 * Any dotted single-quoted / backtick string literal. Keys are frequently
 * selected in a ternary before being passed to the pipe/service (e.g.
 * `foo() ? 'a.b' : 'a.c'`), which the two patterns above cannot see. Double
 * quotes are deliberately excluded so HTML attribute bindings such as
 * `[attr.data-status]="credit.status"` are not mistaken for keys.
 */
const DOTTED_STRING_RE = /['`]([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)[`']/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|html)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function extractUsedKeys(namespaces) {
  const used = new Map(); // key -> Set<file>
  const record = (key, file) => {
    if (!used.has(key)) used.set(key, new Set());
    used.get(key).add(file.replace(frontendRoot + '/', ''));
  };

  for (const file of walk(appRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const re of [PIPE_KEY_RE, CALL_KEY_RE]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(source)) !== null) {
        record(match[1], file);
      }
    }
    DOTTED_STRING_RE.lastIndex = 0;
    let candidate;
    while ((candidate = DOTTED_STRING_RE.exec(source)) !== null) {
      const key = candidate[1];
      if (namespaces.has(key.split('.')[0])) {
        record(key, file);
      }
    }
  }
  return used;
}

function loadCatalog(locale) {
  return JSON.parse(readFileSync(join(i18nDir, `${locale}.json`), 'utf8'));
}

function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function main() {
  const errors = [];
  const catalogs = Object.fromEntries(ACTIVE_LOCALES.map((l) => [l, loadCatalog(l)]));
  const canonical = catalogs[DEFAULT_LOCALE];
  const canonicalKeys = Object.keys(canonical);
  const namespaces = new Set(canonicalKeys.map((k) => k.split('.')[0]));
  const used = extractUsedKeys(namespaces);

  // 1. Every referenced key must exist in the canonical catalog.
  for (const [key, files] of used) {
    if (!(key in canonical)) {
      errors.push(`Used but missing from ${DEFAULT_LOCALE}.json: "${key}" (${[...files].join(', ')})`);
    }
  }

  // 2. Canonical keys must be complete across every active locale.
  for (const locale of ACTIVE_LOCALES) {
    const catalog = catalogs[locale];
    const keys = Object.keys(catalog);
    const missing = canonicalKeys.filter((k) => !(k in catalog));
    const extra = keys.filter((k) => !(k in canonical));
    const empty = keys.filter((k) => !String(catalog[k]).trim());

    if (missing.length) {
      errors.push(`${locale}.json is missing ${missing.length} key(s): ${missing.join(', ')}`);
    }
    if (extra.length) {
      errors.push(`${locale}.json has ${extra.length} key(s) absent from ${DEFAULT_LOCALE}.json: ${extra.join(', ')}`);
    }
    if (empty.length) {
      errors.push(`${locale}.json has ${empty.length} empty value(s): ${empty.join(', ')}`);
    }

    for (const key of canonicalKeys) {
      if (!(key in catalog)) continue;
      const a = placeholders(canonical[key]).join(',');
      const b = placeholders(catalog[key]).join(',');
      if (a !== b) {
        errors.push(`Placeholder mismatch for "${key}": ${DEFAULT_LOCALE}=[${a}] ${locale}=[${b}]`);
      }
    }
  }

  // 3. Every key actually used in source should be referenced (stale-key guard
  //    is informational only — keys can be referenced dynamically).
  const unused = canonicalKeys.filter((k) => !used.has(k));

  if (errors.length) {
    console.error(`\n✖ i18n check failed with ${errors.length} issue(s):\n`);
    for (const err of errors) console.error(`  • ${err}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `✔ i18n check passed — ${used.size} referenced key(s), ${canonicalKeys.length} key(s) in ` +
      `each of ${ACTIVE_LOCALES.join(', ')}` +
      (unused.length ? ` (${unused.length} key(s) not statically referenced)` : ''),
  );
}

main();
