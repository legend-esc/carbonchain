/**
 * Issue #970 — Marketplace: wallet-mock e2e coverage for signed buy / cancel
 * paths via `OfferDetailComponent`.
 *
 * Covers:
 *
 *  ✓ signed buy success — emits `buy` output, clears error
 *  ✓ userRejected — shows friendly cancellation message, no output emitted
 *  ✓ stale-envelope recovery — retries once with a fresh XDR, then emits buy
 *  ✓ stale-envelope exhausted — gives up after one retry, shows error
 *  ✓ network-block — simulated mid-flow disconnect shows unsupported message
 *  ✓ signed buy multi-currency (USDC) — same flow, different asset label
 *  ✓ cancel offer success — emits `cancelled` output
 *
 * All signing goes through `buildWalletMock()` (no real Freighter extension).
 * The component under test is `OfferDetailComponent` which contains the full
 * `executeBuy()` → `signAndSubmit()` loop described in issue #960.
 */

import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal, ComponentRef } from '@angular/core';
import { of, throwError } from 'rxjs';

import { OfferDetailComponent } from '../../marketplace/offer-detail.component';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { StellarWalletService } from '../../core/services/stellar-wallet.service';
import { Offer } from '@shared';
import { WALLET_ERROR_MESSAGES, WalletError } from '../../core/services/wallet-errors';
import { buildWalletMock, MOCK_PUBLIC_KEY, MOCK_SIGNED_XDR } from '../mocks/wallet.mock';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const SELLER_PK = 'GSELLER1234567890ABCDEFGHIJ';
const BUYER_PK = MOCK_PUBLIC_KEY;

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: '42',
    seller: SELLER_PK,
    credit_id: 'deadbeef1234',
    price_xlm: '50000000',
    tonnes_available: '5000000',
    created_at: 1700000000,
    status: 'open',
    ...overrides,
  };
}

const XLM_OFFER = makeOffer();

const USDC_OFFER = makeOffer({
  id: '99',
  payment_asset_code: 'USDC',
  payment_asset_issuer: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  price_raw: '20000000',
  price_xlm: undefined,
});

const UNSIGNED_XDR = 'UNSIGNED-XDR-PLACEHOLDER-ABCDEF';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApiMock() {
  return {
    getBuyOfferXdr: vi.fn().mockReturnValue(of({ xdr: UNSIGNED_XDR })),
    buyOffer: vi.fn().mockReturnValue(of(undefined)),
    cancelOffer: vi.fn().mockReturnValue(of(undefined)),
    getBuyQuote: vi.fn().mockReturnValue(of(null)),
  };
}

function buildAuthMock(token = 'mock-jwt') {
  return {
    isAuthenticated: signal(true).asReadonly(),
    token: signal(token).asReadonly(),
    authState: signal('authenticated' as const).asReadonly(),
    authError: signal(null).asReadonly(),
  };
}

// ── Spec ──────────────────────────────────────────────────────────────────────

describe('[e2e] OfferDetailComponent — wallet signing paths (issue #970)', () => {
  let wallet: ReturnType<typeof buildWalletMock>;
  let apiMock: ReturnType<typeof buildApiMock>;
  let fixture: ComponentFixture<OfferDetailComponent>;
  let comp: OfferDetailComponent;
  let ref: ComponentRef<OfferDetailComponent>;

  function setupComponent(offer: Offer) {
    fixture = TestBed.createComponent(OfferDetailComponent);
    ref = fixture.componentRef;
    ref.setInput('offer', offer);
    ref.setInput('errorCode', null);
    comp = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(async () => {
    TestBed.resetTestingModule();

    wallet = buildWalletMock({ publicKey: BUYER_PK });
    apiMock = buildApiMock();

    await TestBed.configureTestingModule({
      imports: [OfferDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiMock },
        { provide: AuthService, useValue: buildAuthMock() },
        { provide: StellarWalletService, useValue: wallet },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    wallet.reset();
  });

  // ── 1. Signed buy success (XLM) ───────────────────────────────────────────

  it('success: fetches XDR, signs, submits, emits buy output', async () => {
    setupComponent(XLM_OFFER);
    const buyEvents: Offer[] = [];
    comp.buy.subscribe((o) => buyEvents.push(o));

    wallet.setSignOutcome('success');

    await comp.executeBuy();

    expect(apiMock.getBuyOfferXdr).toHaveBeenCalledOnce();
    expect(wallet.signTransaction).toHaveBeenCalledWith(UNSIGNED_XDR);
    expect(apiMock.buyOffer).toHaveBeenCalledWith(
      42, // numeric offer id
      BUYER_PK,
      MOCK_SIGNED_XDR,
      'mock-jwt',
    );
    expect(buyEvents).toHaveLength(1);
    expect(buyEvents[0]).toEqual(XLM_OFFER);
    expect(comp.buyError()).toBeNull();
    expect(comp.actionBusy()).toBe(false);
  });

  // ── 2. userRejected ───────────────────────────────────────────────────────

  it('userRejected: shows friendly message, does not emit buy, does not retry', async () => {
    setupComponent(XLM_OFFER);
    const buyEvents: Offer[] = [];
    comp.buy.subscribe((o) => buyEvents.push(o));

    wallet.setSignOutcome('userRejected');

    await comp.executeBuy();

    expect(wallet.signTransaction).toHaveBeenCalledTimes(1); // no retry
    expect(apiMock.buyOffer).not.toHaveBeenCalled();
    expect(buyEvents).toHaveLength(0);
    expect(comp.buyError()).toBe(WALLET_ERROR_MESSAGES.userRejected);
    expect(comp.actionBusy()).toBe(false);
  });

  // ── 3. stale-envelope: succeeds on second attempt ────────────────────────

  it('staleEnvelope recovery: retries once with fresh XDR, then emits buy', async () => {
    setupComponent(XLM_OFFER);
    const buyEvents: Offer[] = [];
    comp.buy.subscribe((o) => buyEvents.push(o));

    // First sign call: stale; second: success.
    wallet.signTransaction
      .mockRejectedValueOnce(new WalletError('tx_bad_seq', 'staleEnvelope'))
      .mockResolvedValueOnce(MOCK_SIGNED_XDR);

    await comp.executeBuy();

    // XDR is fetched twice (fresh envelope per attempt).
    expect(apiMock.getBuyOfferXdr).toHaveBeenCalledTimes(2);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(apiMock.buyOffer).toHaveBeenCalledTimes(1);
    expect(buyEvents).toHaveLength(1);
    expect(comp.buyError()).toBeNull();
  });

  // ── 4. stale-envelope exhausted ──────────────────────────────────────────

  it('staleEnvelope x2: gives up after one retry, shows error, no buy emitted', async () => {
    setupComponent(XLM_OFFER);
    const buyEvents: Offer[] = [];
    comp.buy.subscribe((o) => buyEvents.push(o));

    wallet.signTransaction.mockRejectedValue(new WalletError('tx_bad_seq', 'staleEnvelope'));

    await comp.executeBuy();

    expect(wallet.signTransaction).toHaveBeenCalledTimes(2);
    expect(apiMock.buyOffer).not.toHaveBeenCalled();
    expect(buyEvents).toHaveLength(0);
    expect(comp.buyError()).toBe(WALLET_ERROR_MESSAGES.staleEnvelope);
  });

  // ── 5. Network-block / mid-flow disconnect ────────────────────────────────

  it('network-block: wallet disconnects before sign, shows network error', async () => {
    setupComponent(XLM_OFFER);

    wallet.simulateDisconnect();
    wallet.signTransaction.mockRejectedValue(new WalletError('net::ERR_BAD_RESPONSE', 'network'));

    await comp.executeBuy();

    expect(comp.buyError()).toBe(WALLET_ERROR_MESSAGES.network);
    expect(comp.actionBusy()).toBe(false);
  });

  // ── 6. Signed buy — multi-currency (USDC) ────────────────────────────────

  it('USDC offer: signs and submits with the correct offer ID, no XLM assumptions', async () => {
    setupComponent(USDC_OFFER);
    const buyEvents: Offer[] = [];
    comp.buy.subscribe((o) => buyEvents.push(o));

    wallet.setSignOutcome('success');

    await comp.executeBuy();

    expect(apiMock.getBuyOfferXdr).toHaveBeenCalledWith(
      99, // USDC offer id
      BUYER_PK,
      'mock-jwt',
    );
    expect(buyEvents).toHaveLength(1);
    expect(buyEvents[0].id).toBe('99');
    expect(comp.buyError()).toBeNull();
  });

  it('USDC offer: payment asset label shows USDC not XLM', () => {
    setupComponent(USDC_OFFER);
    expect(comp.paymentAssetLabel()).toContain('USDC');
    expect(comp.paymentAssetLabel()).not.toContain('XLM');
  });

  // ── 7. Cancel offer success ───────────────────────────────────────────────

  it('cancel: seller can cancel an offer, emits cancelled output', async () => {
    // Make the wallet public key match the seller so `isSeller()` returns true.
    const sellerWallet = buildWalletMock({ publicKey: SELLER_PK });
    TestBed.overrideProvider(StellarWalletService, { useValue: sellerWallet });

    setupComponent(XLM_OFFER);
    const cancelledEvents: Offer[] = [];
    comp.cancelled.subscribe((o) => cancelledEvents.push(o));

    await comp.cancelOffer();

    expect(apiMock.cancelOffer).toHaveBeenCalledWith(42, SELLER_PK, 'mock-jwt');
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]).toEqual(XLM_OFFER);
    expect(comp.buyError()).toBeNull();
  });

  // ── 8. actionStatus live-region updates during buy flow ──────────────────

  it('actionStatus transitions through expected states during a successful buy', async () => {
    const statuses: string[] = [];
    setupComponent(XLM_OFFER);

    // Intercept sign to capture intermediate status.
    wallet.signTransaction.mockImplementation(async () => {
      statuses.push(comp.actionStatus());
      return MOCK_SIGNED_XDR;
    });

    apiMock.buyOffer = vi.fn().mockImplementation(() => {
      statuses.push(comp.actionStatus());
      return of(undefined);
    });

    await comp.executeBuy();

    // At signing time the status should tell the user we are waiting.
    expect(statuses.some((s) => /wallet/i.test(s))).toBe(true);
    // At submit time the status should mention submitting.
    expect(statuses.some((s) => /submit/i.test(s))).toBe(true);
    // After completion the final status message reflects success.
    expect(comp.actionStatus()).toMatch(/submitted/i);
  });

  // ── 9. Unauthenticated buyer ──────────────────────────────────────────────

  it('no token: shows auth error immediately without touching wallet or API', async () => {
    await TestBed.configureTestingModule({
      imports: [OfferDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiMock },
        {
          provide: AuthService,
          useValue: {
            isAuthenticated: signal(false).asReadonly(),
            token: signal(null).asReadonly(),
            authState: signal('unauthenticated' as const).asReadonly(),
            authError: signal(null).asReadonly(),
          },
        },
        { provide: StellarWalletService, useValue: wallet },
      ],
    }).compileComponents();

    setupComponent(XLM_OFFER);

    await comp.executeBuy();

    expect(apiMock.getBuyOfferXdr).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(comp.buyError()).toContain('not authenticated');
  });
});
