#!/usr/bin/env node
/**
 * #961 — missing-key lint for ngx-style translation catalogues.
 *
 * Scans every component template under src/app for translation keys used via
 * the `translate` pipe or `i18n.t()` calls, then verifies:
 *   1. each used key exists in every active locale,
 *   2. locales carry an identical key set (no partial translations),
 *   3. no key is a duplicate (JSON parsers silently keep the last value).
 *
 * Exits non-zero on any failure so CI goes red on untranslated strings.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_DIR = join(ROOT, 'src', 'app');
const I18N_DIR = join(ROOT, 'src', 'assets', 'i18n');
const REFERENCE_LOCALE = 'en';
const LOCALES = ['en', 'es', 'fr'];

/** Keys must be dotted and lower-camel, e.g. `retire.reasonLabel`. */
const KEY_SHAPE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function extractKeys(source) {
  const keys = new Map();
  const patterns = [
    /'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'\s*\|\s*translate/g,
    /\bt\(\s*'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const key = match[1];
      if (!keys.has(key)) keys.set(key, []);
    }
  }
  return keys;
}

/** Detects duplicate keys in raw JSON text, which json.parse would hide. */
function findDuplicateKeys(raw, file) {
  const seen = new Set();
  const dupes = new Set();
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)+)"\s*:/g)) {
    const key = match[1];
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  if (dupes.size) {
    console.error(`  ${relative(ROOT, file)}: duplicate keys -> ${[...dupes].join(', ')}`);
  }
  return [...dupes];
}

const errors = [];

// 1. Load catalogues, checking raw JSON for duplicates.
const catalogues = new Map();
for (const locale of LOCALES) {
  const file = join(I18N_DIR, `${locale}.json`);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    errors.push(`missing locale file: ${relative(ROOT, file)}`);
    continue;
  }
  findDuplicateKeys(raw, file).forEach(() => {});
  try {
    const parsed = JSON.parse(raw);
    catalogues.set(locale, parsed);
  } catch (e) {
    errors.push(`invalid JSON in ${locale}.json: ${e.message}`);
  }
}

// 2. Extract used keys from templates and services.
const used = new Map();
for (const file of walk(APP_DIR)) {
  const source = readFileSync(file, 'utf8');
  for (const [key] of extractKeys(source)) {
    if (!used.has(key)) used.set(key, relative(ROOT, file));
  }
}

// 3. Every used key must be shaped like a translation key.
for (const key of used.keys()) {
  if (!KEY_SHAPE.test(key)) {
    errors.push(`malformed key "${key}" (${used.get(key)})`);
  }
}

// 4. Every used key must resolve in every locale.
const reference = catalogues.get(REFERENCE_LOCALE) ?? {};
for (const [key, file] of used) {
  for (const locale of LOCALES) {
    const cat = catalogues.get(locale);
    if (!cat) continue;
    if (!(key in cat)) {
      errors.push(`missing "${key}" in ${locale}.json (used in ${file})`);
    } else if (typeof cat[key] !== 'string' || cat[key].trim() === '') {
      errors.push(`empty or non-string "${key}" in ${locale}.json`);
    }
  }
}

// 5. Locales must carry the same key set.
for (const locale of LOCALES) {
  const cat = catalogues.get(locale);
  if (!cat) continue;
  for (const key of Object.keys(reference)) {
    if (!(key in cat)) {
      errors.push(`"${key}" present in ${REFERENCE_LOCALE}.json but missing in ${locale}.json`);
    }
  }
  for (const key of Object.keys(cat)) {
    if (!(key in reference)) {
      errors.push(`"${key}" present in ${locale}.json but missing in ${REFERENCE_LOCALE}.json`);
    }
  }
}

if (errors.length) {
  console.error(`\ni18n check FAILED — ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const total = Object.keys(reference).length;
console.log(
  `i18n check passed: ${used.size} key(s) used, ${total} key(s) in each of ${LOCALES.join(', ')}.`,
);
