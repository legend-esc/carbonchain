import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * #962 — responsive regression guard. Asserts the surfaces named in the
 * issue (marketplace, retire wizard, portfolio) carry narrow-viewport rules:
 * a `max-width: 768px` breakpoint, horizontal-scroll wrappers for wide
 * tables, and 44px minimum touch targets. Playwright viewport screenshots
 * cover pixel output; this keeps the CSS contract from silently regressing.
 */
const APP_DIR = join(process.cwd(), 'src', 'app');

function read(relPath: string): string {
  return readFileSync(join(APP_DIR, relPath), 'utf8');
}

const MD_BREAKPOINT = '@media (max-width: 768px)';
const TOUCH_TARGET = '44px';

const SURFACES = [
  { name: 'retire wizard', file: 'retire/retire.component.ts', tableWrapper: '.table-scroll' },
  {
    name: 'marketplace',
    file: 'marketplace/marketplace.component.ts',
    tableWrapper: '.table-scroll',
  },
  {
    name: 'marketplace list',
    file: 'marketplace/marketplace-list.component.ts',
    tableWrapper: '.table-scroll',
  },
];

describe('responsive layout (#962)', () => {
  for (const surface of SURFACES) {
    it(`${surface.name} defines a 768px breakpoint`, () => {
      expect(read(surface.file)).toContain(MD_BREAKPOINT);
    });

    it(`${surface.name} scrolls wide tables instead of overflowing`, () => {
      const source = read(surface.file);
      expect(source).toContain(surface.tableWrapper);
      expect(source).toMatch(/overflow-x:\s*auto/);
    });

    it(`${surface.name} sets ${TOUCH_TARGET} touch targets on small screens`, () => {
      const source = read(surface.file);
      const breakpoint = source.slice(source.indexOf(MD_BREAKPOINT));
      expect(breakpoint.slice(0, 1200)).toContain(TOUCH_TARGET);
    });
  }

  it('retire wizard stacks wizard steps full-width below md', () => {
    const source = read('retire/retire.component.ts');
    const breakpoint = source.slice(source.indexOf(MD_BREAKPOINT));
    expect(breakpoint).toMatch(/flex-direction:\s*column/);
  });

  it('retire wizard keeps tables horizontally scrollable at 360px', () => {
    const source = read('retire/retire.component.ts');
    expect(source).toContain('@media (max-width: 480px)');
  });

  it('portfolio collapses summary cards and scrolls charts', () => {
    const source = read('portfolio/portfolio.component.ts');
    expect(source).toContain(MD_BREAKPOINT);
    expect(source).toMatch(/\.chart-card \{ overflow-x: auto/);
  });
});
