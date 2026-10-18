import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * #964 — asserts the service worker config caches read paths and leaves write
 * paths (POST/PUT/DELETE) network-only. Angular's SW only caches GETs, so
 * the guard is that every dataGroup is a read URL and no group targets an
 * auth or mutation endpoint.
 */
const config = JSON.parse(readFileSync(join(process.cwd(), 'ngsw-config.json'), 'utf8')) as {
  index: string;
  assetGroups: { name: string; installMode: string; resources: { files: string[] } }[];
  dataGroups: { name: string; urls: string[]; cacheConfig: { strategy: string } }[];
};

const MUTATION_URLS = ['retirement', 'auth', 'verifiers', 'admin', 'offer'];

describe('ngsw-config (#964)', () => {
  it('sets an app shell index for navigation fallback', () => {
    expect(config.index).toBe('/index.html');
  });

  it('precaches the app shell', () => {
    const app = config.assetGroups.find((g) => g.name === 'app');
    expect(app).toBeDefined();
    expect(app!.installMode).toBe('prefetch');
    expect(app!.resources.files).toContain('/index.html');
    expect(app!.resources.files.some((f) => f.endsWith('.js'))).toBe(true);
  });

  it('caches portfolio holdings with a network-first (freshness) strategy', () => {
    const group = config.dataGroups.find((g) => g.name === 'portfolio-holdings');
    expect(group).toBeDefined();
    expect(group!.cacheConfig.strategy).toBe('freshness');
    expect(group!.urls).toContain('/api/v1/credits');
  });

  it('caches marketplace listings and project detail with a freshness strategy', () => {
    const group = config.dataGroups.find((g) => g.name === 'marketplace-listings');
    expect(group).toBeDefined();
    expect(group!.cacheConfig.strategy).toBe('freshness');
    expect(group!.urls.some((u) => u.includes('marketplace'))).toBe(true);
    expect(group!.urls.some((u) => u.includes('projects'))).toBe(true);
  });

  it('does not cache mutation or auth endpoints', () => {
    for (const group of config.dataGroups) {
      for (const url of group.urls) {
        for (const segment of MUTATION_URLS) {
          expect(url, `${group.name} must not cache ${segment}`).not.toContain(segment);
        }
      }
    }
  });

  it('uses unique group names (naming collisions silently drop groups)', () => {
    const names = config.dataGroups.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
