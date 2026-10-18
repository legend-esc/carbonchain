/**
 * Issue #970 — Retire wizard: wallet-mock e2e coverage for signing paths.
 *
 * Covers the scenarios that were previously tested only at the server-
 * integration level (or not at all):
 *
 *  ✓ signed retire success — wizard completes and navigates to certificate
 *  ✓ userRejected — friendly cancellation message, no navigation, no retry
 *  ✓ stale-envelope recovery — rebuilds XDR and retries once, then succeeds
 *  ✓ stale-envelope exhausted — gives up after one retry, shows error
 *  ✓ timeout error — shows timeout message, stays on step 3
 *  ✓ network error — shows network message
 *  ✓ network-block (wallet disconnects mid-flow)
 *
 * All signing interactions go through `buildWalletMock()` — no real Freighter
 * extension is required.  The mock is fully documented in
 * `src/app/shared/mocks/wallet.mock.ts`.
 */

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';

import { RetireComponent } from '../../retire/retire.component';
import { AuthService } from '../../core/services/auth.service';
import { StellarWalletService } from '../../core/services/stellar-wallet.service';
import { ApiService } from '../../core/services/api.service';
import { CreditStore } from '../../core/store/credit.store';
import { ToastService } from '../../core/services/toast.service';
import { CreditMetadata, CreditStatus } from '@shared';
import { WALLET_ERROR_MESSAGES, WalletError } from '../../core/services/wallet-errors';
import { buildWalletMock, MOCK_PUBLIC_KEY } from '../mocks/wallet.mock';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const credit: CreditMetadata = {
  id: '037176a1beefdead',
  project_id: 'PROJ-001',
  issuer: 'GISSUER123',
  owner: MOCK_PUBLIC_KEY,
  vintage_year: 2024,
  methodology: 'VCS',
  geography: 'NG',
  tonnes: '1000000',
  ipfs_hash: 'bafybei...',
  status: CreditStatus.Active,
  issued_at: 1710000000,
};

const RETIREMENT_ID = 'retire-cert-abc123';

// ── Spec ──────────────────────────────────────────────────────────────────────

describe('[e2e] RetireComponent — wallet signing paths (issue #970)', () => {
  let wallet: ReturnType<typeof buildWalletMock>;
  let apiMock: ReturnType<typeof buildApiMock>;
  let routerMock: { navigate: ReturnType<typeof vi.fn> };
  let toastMock: { showSuccess: ReturnType<typeof vi.fn>; showError: ReturnType<typeof vi.fn> };
  let creditsSignal: ReturnType<typeof signal<CreditMetadata[]>>;

  function buildApiMock() {
    return {
      retireCredit: vi.fn().mockReturnValue(of({ retirementId: RETIREMENT_ID })),
      batchRetire: vi
        .fn()
        .mockReturnValue(of({ succeeded: [RETIREMENT_ID, 'retire-cert-2'], failed: [] })),
    };
  }

  function buildAuthMock() {
    return {
      isAuthenticated: signal(true).asReadonly(),
      token: signal('mock-jwt-token').asReadonly(),
      authState: signal('authenticated' as const).asReadonly(),
      authError: signal(null).asReadonly(),
    };
  }

  beforeEach(() => {
    TestBed.resetTestingModule();

    wallet = buildWalletMock();
    apiMock = buildApiMock();
    routerMock = { navigate: vi.fn().mockResolvedValue(true) };
    toastMock = { showSuccess: vi.fn(), showError: vi.fn() };
    creditsSignal = signal<CreditMetadata[]>([credit]);

    const creditStoreMock: Partial<CreditStore> = {
      credits: creditsSignal.asReadonly(),
      isLoading: signal(false).asReadonly(),
      loadOne: vi.fn().mockResolvedValue(undefined),
      loadByOwner: vi.fn().mockResolvedValue(undefined),
    };

    TestBed.configureTestingModule({
      imports: [RetireComponent],
      providers: [
        provideHttpClient(),
        { provide: AuthService, useValue: buildAuthMock() },
        { provide: StellarWalletService, useValue: wallet },
        { provide: ApiService, useValue: apiMock },
        { provide: CreditStore, useValue: creditStoreMock },
        { provide: ToastService, useValue: toastMock },
        { provide: Router, useValue: routerMock },
      ],
    });
  });

  afterEach(() => {
    wallet.reset();
  });

  // ── Helper: build a component that is fully set up for step 3 (confirm). ──

  function buildReadyToSubmit(): InstanceType<typeof RetireComponent> {
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.selectedCredits.set([credit]);
    comp.reasonControl.setValue('2024 Scope 3 offset');
    comp.currentStep.set(3);
    return comp;
  }

  // ── 1. Signed retire success ───────────────────────────────────────────────

  it('success: retires credit, navigates to certificate, clears signing error', async () => {
    wallet.setSignOutcome('success');
    const comp = buildReadyToSubmit();

    await comp.submit();

    expect(apiMock.retireCredit).toHaveBeenCalledOnce();
    expect(apiMock.retireCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerPublicKey: MOCK_PUBLIC_KEY,
        creditId: credit.id,
        reason: '2024 Scope 3 offset',
      }),
      'mock-jwt-token',
    );
    expect(routerMock.navigate).toHaveBeenCalledWith(['/certificates', RETIREMENT_ID]);
    expect(comp.signingError()).toBeNull();
    expect(comp.submitting()).toBe(false);
  });

  // ── 2. userRejected ───────────────────────────────────────────────────────

  it('userRejected: shows friendly cancellation message, does not navigate, does not retry', async () => {
    apiMock.retireCredit = vi
      .fn()
      .mockReturnValue(
        throwError(() => new WalletError('User rejected the request', 'userRejected')),
      );
    const comp = buildReadyToSubmit();

    await comp.submit();

    expect(apiMock.retireCredit).toHaveBeenCalledTimes(1); // no retry
    expect(comp.signingError()).toBe(WALLET_ERROR_MESSAGES.userRejected);
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(comp.currentStep()).toBe(3); // stays on confirm step
    expect(comp.submitting()).toBe(false);
  });

  // ── 3. stale-envelope recovery (succeeds on second attempt) ──────────────

  it('staleEnvelope: rebuilds XDR and retries once, then navigates on success', async () => {
    apiMock.retireCredit = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new WalletError('tx_bad_seq', 'staleEnvelope')))
      .mockReturnValueOnce(of({ retirementId: RETIREMENT_ID }));
    const comp = buildReadyToSubmit();

    await comp.submit();

    expect(apiMock.retireCredit).toHaveBeenCalledTimes(2);
    expect(routerMock.navigate).toHaveBeenCalledWith(['/certificates', RETIREMENT_ID]);
    expect(comp.signingError()).toBeNull();
  });

  // ── 4. stale-envelope exhausted (both attempts fail) ─────────────────────

  it('staleEnvelope x2: gives up after one retry, shows staleEnvelope message', async () => {
    apiMock.retireCredit = vi
      .fn()
      .mockReturnValue(throwError(() => new WalletError('tx_bad_seq', 'staleEnvelope')));
    const comp = buildReadyToSubmit();

    await comp.submit();

    expect(apiMock.retireCredit).toHaveBeenCalledTimes(2);
    expect(comp.signingError()).toBe(WALLET_ERROR_MESSAGES.staleEnvelope);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  // ── 5. Timeout ────────────────────────────────────────────────────────────

  it('timeout: shows timeout message and stays on step 3', async () => {
    apiMock.retireCredit = vi
      .fn()
      .mockReturnValue(
        throwError(() => new WalletError('Wallet did not respond within 60s.', 'timeout')),
      );
    const comp = buildReadyToSubmit();

    await comp.submit();

    expect(comp.signingError()).toBe(WALLET_ERROR_MESSAGES.timeout);
    expect(comp.currentStep()).toBe(3);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  // ── 6. Network / transport error ──────────────────────────────────────────

  it('network error: shows network message', async () => {
    apiMock.retireCredit = vi
      .fn()
      .mockReturnValue(throwError(() => new WalletError('net::ERR_BAD_RESPONSE', 'network')));
    const comp = buildReadyToSubmit();

    await comp.submit();

    expect(comp.signingError()).toBe(WALLET_ERROR_MESSAGES.network);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  // ── 7. Network-block: wallet disconnects before submission ────────────────

  it('network-block: wallet disconnected mid-flow shows unsupported/disconnected message', async () => {
    wallet.simulateDisconnect();
    apiMock.retireCredit = vi
      .fn()
      .mockReturnValue(
        throwError(() => new WalletError('Wallet is not connected.', 'unsupported')),
      );
    const comp = buildReadyToSubmit();

    await comp.submit();

    expect(comp.signingError()).toBe(WALLET_ERROR_MESSAGES.unsupported);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  // ── 8. Batch retire: signed retirement of multiple credits ────────────────

  it('batch retire success: retires multiple credits and navigates to first certificate', async () => {
    const creditB: CreditMetadata = {
      ...credit,
      id: 'bbb222ccc333',
      tonnes: '2000000',
    };
    wallet.setSignOutcome('success');
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.selectedCredits.set([credit, creditB]);
    comp.reasonControl.setValue('Annual batch offset');
    comp.currentStep.set(3);

    await comp.submit();

    expect(apiMock.batchRetire).toHaveBeenCalledOnce();
    expect(apiMock.batchRetire).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerPublicKey: MOCK_PUBLIC_KEY,
        creditIds: [credit.id, creditB.id],
        reason: 'Annual batch offset',
      }),
      'mock-jwt-token',
    );
    expect(routerMock.navigate).toHaveBeenCalledWith(['/certificates', RETIREMENT_ID]);
  });

  // ── 9. Step 3 UI — signing state toggles while submitting ─────────────────

  it('submitting signal is true while the request is in-flight', () => {
    // Replace retireCredit with a Promise that never resolves so we can
    // inspect the in-flight state synchronously after calling submit().
    let resolve!: (value: unknown) => void;
    apiMock.retireCredit = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    const comp = buildReadyToSubmit();

    // Do not await — inspect mid-flight.
    void comp.submit();

    // Signal flips to true immediately.
    expect(comp.submitting()).toBe(true);

    // Clean up: resolve so the Promise chain settles.
    resolve({ retirementId: RETIREMENT_ID });
  });
});
