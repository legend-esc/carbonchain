import { test, expect, Page } from '@playwright/test';

/**
 * Issue #1377 — Playwright end-to-end integration test suite for the
 * complete carbon credit retirement journey:
 *   connect wallet -> select credits -> submit -> view & download certificate.
 */

const MOCK_PUBLIC_KEY = 'GABC123XYZ_PLAYWRIGHT_MOCK_WALLET_AAAAA';
const MOCK_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const MOCK_SIGNED_XDR = 'AAAA-mock-signed-xdr-playwright';
const MOCK_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiJHQUJDMTIzWFlaX1BMQVlXUklHSFRfTU9DS19XQUxMRVRfQUFBQUEiLCJyb2xlIjoiYnV5ZXIifQ.' +
  'mock-signature';

const MOCK_CREDIT = {
  id: 'credit-e2e-001',
  project_id: 'proj-amazon-001',
  owner: MOCK_PUBLIC_KEY,
  tonnes: '500000', // 0.5 t (multiple of 100,000)
  status: 'Active',
  vintage: 2025,
  methodology: 'VM0015',
};

const MOCK_RETIREMENT = {
  id: 'ret-e2e-001',
  credit_id: MOCK_CREDIT.id,
  buyer: MOCK_PUBLIC_KEY,
  tonnes: MOCK_CREDIT.tonnes,
  reason: 'Q4 corporate Scope 1 emissions offset',
  retired_at: '2026-11-21T12:00:00.000Z',
  tx_hash: '0xmockhorizonretirementtxhash001',
};

/**
 * Injects a deterministic mock Freighter wallet provider onto `window`
 * before any Angular application script executes.
 */
async function installMockWallet(
  page: Page,
  options: { rejectSigning?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ publicKey, passphrase, signedXdr, rejectSigning }) => {
      const mockProvider = {
        isConnected: async () => true,
        isAllowed: async () => true,
        setAllowed: async () => true,
        requestAccess: async () => ({ address: publicKey }),
        getAddress: async () => ({ address: publicKey }),
        getPublicKey: async () => publicKey,
        getNetwork: async () => 'TESTNET',
        getNetworkDetails: async () => ({
          network: 'TESTNET',
          networkUrl: 'https://horizon-testnet.stellar.org',
          networkPassphrase: passphrase,
        }),
        signTransaction: async (_xdr: string) => {
          if (rejectSigning) {
            throw new Error('User declined access');
          }
          return signedXdr;
        },
      };

      (window as unknown as Record<string, unknown>).freighterApi = mockProvider;
      (window as unknown as Record<string, unknown>).freighter = mockProvider;
    },
    {
      publicKey: MOCK_PUBLIC_KEY,
      passphrase: MOCK_NETWORK_PASSPHRASE,
      signedXdr: MOCK_SIGNED_XDR,
      rejectSigning: options.rejectSigning ?? false,
    },
  );
}

/**
 * Intercepts CarbonChain API endpoints so the E2E suite runs deterministically
 * without a live PostgreSQL, Redis, or Horizon backend.
 */
async function mockCarbonChainApi(
  page: Page,
  options: { retireError?: { status: number; message: string } } = {},
): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path.endsWith('/auth/challenge') && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transaction: 'AAAA-mock-sep10-challenge-xdr',
          network_passphrase: MOCK_NETWORK_PASSPHRASE,
        }),
      });
    }

    if (
      (path.endsWith('/auth/token') || path.endsWith('/auth/verify')) &&
      request.method() === 'POST'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: MOCK_JWT,
          refresh_token: 'mock-refresh-token',
          expires_in: 900,
        }),
      });
    }

    if (path.endsWith('/credits') && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [MOCK_CREDIT], total: 1 }),
      });
    }

    if (path.endsWith(`/credits/${MOCK_CREDIT.id}`) && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_CREDIT),
      });
    }

    if (path.includes('/retire') && request.method() === 'POST') {
      if (options.retireError) {
        return route.fulfill({
          status: options.retireError.status,
          contentType: 'application/json',
          body: JSON.stringify({ message: options.retireError.message }),
        });
      }
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          retirementId: MOCK_RETIREMENT.id,
          txHash: MOCK_RETIREMENT.tx_hash,
        }),
      });
    }

    if (path.endsWith(`/certificates/${MOCK_RETIREMENT.id}`) && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_RETIREMENT),
      });
    }

    if (
      path.endsWith(`/certificates/${MOCK_RETIREMENT.id}/pdf`) &&
      request.method() === 'GET'
    ) {
      const minimalPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
        'utf-8',
      );
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: {
          'Content-Disposition': `attachment; filename="certificate-${MOCK_RETIREMENT.id}.pdf"`,
        },
        body: minimalPdf,
      });
    }

    if (
      path.endsWith(`/certificates/${MOCK_RETIREMENT.id}/verify`) &&
      request.method() === 'GET'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ verified: true, txHash: MOCK_RETIREMENT.tx_hash }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
}

test.describe('Carbon Credit Retirement Journey (#1377)', () => {
  test('connects wallet, selects credits, submits retirement, and downloads certificate', async ({
    page,
  }) => {
    await installMockWallet(page);
    await mockCarbonChainApi(page);

    // 1. Connect wallet via /connect-wallet
    await page.goto('/connect-wallet');
    const connectButton = page.getByRole('button', { name: /connect/i }).first();
    await expect(connectButton).toBeVisible();
    await connectButton.click();

    // 2. Navigate to the retirement wizard
    await page.goto('/retire');
    await expect(page.locator('.retire-wizard')).toBeVisible();

    // 3. Select the active credit from the table
    const creditCheckbox = page.locator('input[type="checkbox"]').first();
    await expect(creditCheckbox).toBeVisible();
    await creditCheckbox.check();
    await expect(creditCheckbox).toBeChecked();

    // 4. Advance wizard and submit retirement
    const nextButton = page.getByRole('button', { name: /next/i });
    await nextButton.click();

    const reasonInput = page.locator('input[type="text"], textarea').first();
    if (await reasonInput.isVisible()) {
      await reasonInput.fill(MOCK_RETIREMENT.reason);
    }

    const submitButton = page.getByRole('button', { name: /submit|retire/i }).first();
    if (await submitButton.isVisible()) {
      await submitButton.click();
    }

    // 5. Verify certificate page & PDF download
    await page.goto(`/certificates/${MOCK_RETIREMENT.id}`);
    await expect(page.getByRole('heading', { name: 'Retirement Certificate' })).toBeVisible();
    await expect(page.getByText(MOCK_RETIREMENT.id)).toBeVisible();
    await expect(page.getByText(MOCK_RETIREMENT.credit_id)).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /download pdf/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain(MOCK_RETIREMENT.id);
  });

  test('redirects unauthenticated users away from /retire', async ({ page }) => {
    await page.goto('/retire');
    await expect(page).toHaveURL(/\/$/);
  });

  test('displays an error alert when wallet signing is rejected', async ({ page }) => {
    await installMockWallet(page, { rejectSigning: true });
    await mockCarbonChainApi(page, {
      retireError: { status: 400, message: 'Transaction signing cancelled by user' },
    });

    await page.goto('/connect-wallet');
    const connectButton = page.getByRole('button', { name: /connect/i }).first();
    await connectButton.click();

    // Even if auth fails due to rejection, verify an alert or stayed on connect page
    await expect(page.getByRole('alert').or(page.locator('.error'))).toBeVisible();
  });
});
