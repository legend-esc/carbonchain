import { expect, Page, test } from '@playwright/test';

type ThemeMode = 'light' | 'dark';

interface ViewTarget {
  name: string;
  path: string;
  readySelector: string;
}

const VIEWS: ViewTarget[] = [
  { name: 'dashboard', path: '/dashboard', readySelector: 'main, app-dashboard' },
  { name: 'marketplace', path: '/marketplace', readySelector: 'main, app-marketplace' },
  { name: 'retire', path: '/retire', readySelector: 'main, app-retire' },
];

const THEMES: ThemeMode[] = ['light', 'dark'];

const MOCK_CREDITS = [
  {
    creditId: 'a'.repeat(64),
    projectId: 'PROJ-AMZ-001',
    vintageYear: 2024,
    methodology: 'VCS',
    geography: 'BR',
    tonnes: '10000000',
    status: 'Active',
    owner: 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    issuer: 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    ipfsHash: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    issuedAt: 1710000000,
  },
  {
    creditId: 'b'.repeat(64),
    projectId: 'PROJ-KEN-002',
    vintageYear: 2023,
    methodology: 'Gold Standard',
    geography: 'KE',
    tonnes: '5000000',
    status: 'Active',
    owner: 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    issuer: 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    ipfsHash: 'bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lly',
    issuedAt: 1705000000,
  },
];

const MOCK_OFFERS = [
  {
    offerId: '1',
    creditId: 'a'.repeat(64),
    seller: 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    tonnes: '5000000',
    pricePerTonne: '25000000',
    asset: 'XLM',
    status: 'Active',
    projectId: 'PROJ-AMZ-001',
    methodology: 'VCS',
    vintageYear: 2024,
    geography: 'BR',
  },
];

/**
 * Seeds deterministic auth state, theme preference, and mocked API responses
 * so visual snapshots never flake on network timing or live testnet state.
 */
async function setupMockEnvironment(page: Page, theme: ThemeMode): Promise<void> {
  await page.addInitScript((selectedTheme: ThemeMode) => {
    localStorage.setItem('theme', selectedTheme);
    localStorage.setItem(
      'auth_token',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50IjoiR0NSWlVLTlUySjVHTFNZVFpSNE9MTzdPQkpKVkhTTVZCR0c3SVZVWjU1RlhNRkhVRENMREdRSlgiLCJleHAiOjk5OTk5OTk5OTl9.mock',
    );
    localStorage.setItem(
      'wallet_address',
      'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    );
    document.documentElement.classList.toggle('dark', selectedTheme === 'dark');
  }, theme);

  await page.route('**/credits**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: MOCK_CREDITS,
        total: MOCK_CREDITS.length,
        page: 1,
        limit: 20,
      }),
    });
  });

  await page.route('**/marketplace/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: MOCK_OFFERS,
        total: MOCK_OFFERS.length,
        page: 1,
        limit: 20,
      }),
    });
  });

  await page.route('**/retirement**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], total: 0, page: 1, limit: 20 }),
    });
  });

  await page.route('**/projects**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], total: 0, page: 1, limit: 20 }),
    });
  });
}

test.describe('Visual Regression Suite (#1383)', () => {
  for (const view of VIEWS) {
    for (const theme of THEMES) {
      test(`${view.name} view renders cleanly in ${theme} mode`, async ({ page }) => {
        await setupMockEnvironment(page, theme);

        await page.goto(view.path, { waitUntil: 'networkidle' });
        await page.locator(view.readySelector).first().waitFor({ state: 'visible' });

        // Ensure ThemeService class state matches the requested mode
        await page.evaluate((mode: ThemeMode) => {
          document.documentElement.classList.toggle('dark', mode === 'dark');
        }, theme);

        // Wait for web fonts and CSS transitions to settle
        await page.evaluate(() => document.fonts.ready);

        await expect(page).toHaveScreenshot(`${view.name}-${theme}.png`, {
          fullPage: true,
        });
      });
    }
  }
});
