/**
 * Issue #970 — Deterministic Freighter wallet mock for e2e tests.
 *
 * Implements the same interface as `StellarWalletService` (the subset consumed
 * by `RetireComponent` and `MarketplaceComponent` / `OfferDetailComponent`) so
 * that component specs can exercise the full signing flow without a real browser
 * extension.
 *
 * Key design goals:
 *  - Configurable per-call outcome: success, userRejected, timeout, network,
 *    staleEnvelope, or a custom error. Defaults to `success`.
 *  - All async operations return Promises so specs can `await` them.
 *  - The mock tracks call counts and arguments so tests can assert on them.
 *  - `reset()` restores defaults so each test starts from a clean slate.
 *
 * Usage:
 *
 * ```typescript
 * import { buildWalletMock, WalletMockOutcome } from '../mocks/wallet.mock';
 *
 * let wallet: ReturnType<typeof buildWalletMock>;
 *
 * beforeEach(() => {
 *   wallet = buildWalletMock();
 *   TestBed.configureTestingModule({
 *     providers: [{ provide: StellarWalletService, useValue: wallet }],
 *   });
 * });
 *
 * it('signs successfully', async () => {
 *   wallet.setSignOutcome('success');
 *   await component.submit();
 *   expect(wallet.signTransaction).toHaveBeenCalledOnce();
 * });
 *
 * it('shows user-rejection message', async () => {
 *   wallet.setSignOutcome('userRejected');
 *   await component.submit();
 *   expect(component.signingError()).toContain('cancelled');
 * });
 * ```
 */

import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { WalletError, WalletErrorType } from '../../core/services/wallet-errors';

/** The set of outcomes the mock's `signTransaction` / `signAuthEntry` can produce. */
export type WalletMockOutcome =
  | 'success'
  | WalletErrorType // 'userRejected' | 'timeout' | 'network' | 'staleEnvelope' | 'unsupported' | 'unknown'
  | { customError: Error };

/** The signed XDR string returned on a `success` outcome. */
export const MOCK_SIGNED_XDR = 'AAAA-mock-signed-xdr-1234567890';

/** Default network details returned by `getNetworkDetails()`. */
export const MOCK_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

/** Default public key used for all tests. */
export const MOCK_PUBLIC_KEY = 'GABC123XYZ_MOCK_WALLET_ADDRESS_AAAAA';

/**
 * Build a self-contained wallet mock that satisfies the `StellarWalletService`
 * interface consumed by retire and marketplace components.
 *
 * The return value is intended to be passed directly to Angular's DI:
 *   `{ provide: StellarWalletService, useValue: buildWalletMock() }`
 */
export function buildWalletMock(
  overrides: Partial<{ publicKey: string; network: 'testnet' | 'mainnet' }> = {},
) {
  const pk = overrides.publicKey ?? MOCK_PUBLIC_KEY;

  // ── Mutable outcome controls ─────────────────────────────────────────────
  let _signOutcome: WalletMockOutcome = 'success';
  let _connectOutcome: WalletMockOutcome = 'success';
  let _networkMismatch = false;

  // ── Signals (mirrors StellarWalletService's public API) ──────────────────
  const publicKey = signal<string | null>(pk);
  const state = signal<'disconnected' | 'connecting' | 'connected' | 'error'>('connected');
  const isConnected = signal<boolean>(true);
  const networkMismatch = signal<boolean>(_networkMismatch);
  const expectedNetwork = signal<string>(overrides.network ?? 'testnet');
  const network = signal<'testnet' | 'mainnet' | null>(overrides.network ?? 'testnet');
  const xlmBalance = signal<number | null>(null);
  const balanceError = signal<string | null>(null);
  const error = signal<string | null>(null);

  // ── Observable streams ───────────────────────────────────────────────────
  const networkChanged$ = new Subject<'testnet' | 'mainnet' | null>();
  const addressChanged$ = new Subject<string | null>();
  const scopeChanged$ = new Subject<string>();

  // ── Call-record spies (vi.fn() style via direct assignment) ─────────────
  const signTransaction = vi.fn(async (_xdr: string, _passphrase?: string): Promise<string> => {
    return _resolveSignOutcome(_signOutcome);
  });

  const connect = vi.fn(async (): Promise<string> => {
    if (_connectOutcome !== 'success') {
      throw _buildError(_connectOutcome);
    }
    return pk;
  });

  const getNetworkDetails = vi.fn(async () => ({
    network: overrides.network ?? 'testnet',
    networkPassphrase: MOCK_NETWORK_PASSPHRASE,
  }));

  const checkNetworkMatch = vi.fn(async (): Promise<boolean> => {
    return !_networkMismatch;
  });

  const disconnect = vi.fn(() => {
    publicKey.set(null);
    state.set('disconnected');
  });

  const startBalancePolling = vi.fn();
  const stopBalancePolling = vi.fn();
  const clearNetworkScopedData = vi.fn(() => disconnect());

  // ── Control API (not on StellarWalletService, only for tests) ────────────

  /**
   * Configure what `signTransaction` returns on the next call (and all
   * subsequent calls until changed again).
   *
   * Pass a `WalletErrorType` string to simulate a typed wallet error, or
   * `'success'` to simulate a successfully signed XDR.
   */
  function setSignOutcome(outcome: WalletMockOutcome): void {
    _signOutcome = outcome;
    // Rebuild the spy so call count resets cleanly per-test if desired.
    signTransaction.mockImplementation(async () => _resolveSignOutcome(outcome));
  }

  /**
   * Configure what `connect()` returns.  Rarely needed — most tests start
   * with the mock already "connected".
   */
  function setConnectOutcome(outcome: WalletMockOutcome): void {
    _connectOutcome = outcome;
  }

  /**
   * Simulate a wallet network mismatch so components that show a warning
   * banner can be exercised.
   */
  function setNetworkMismatch(mismatch: boolean): void {
    _networkMismatch = mismatch;
    networkMismatch.set(mismatch);
    checkNetworkMatch.mockResolvedValue(!mismatch);
  }

  /** Simulate a disconnected / unauthenticated wallet. */
  function simulateDisconnect(): void {
    publicKey.set(null);
    state.set('disconnected');
    isConnected.set(false);
  }

  /**
   * Restore all defaults. Call from `afterEach` or `beforeEach` to ensure test
   * isolation.
   */
  function reset(): void {
    _signOutcome = 'success';
    _connectOutcome = 'success';
    _networkMismatch = false;
    publicKey.set(pk);
    state.set('connected');
    isConnected.set(true);
    networkMismatch.set(false);
    signTransaction.mockReset();
    signTransaction.mockImplementation(async () => _resolveSignOutcome('success'));
    connect.mockReset();
    connect.mockResolvedValue(pk);
    getNetworkDetails.mockReset();
    getNetworkDetails.mockResolvedValue({
      network: overrides.network ?? 'testnet',
      networkPassphrase: MOCK_NETWORK_PASSPHRASE,
    });
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  async function _resolveSignOutcome(outcome: WalletMockOutcome): Promise<string> {
    if (outcome === 'success') return MOCK_SIGNED_XDR;
    throw _buildError(outcome);
  }

  function _buildError(outcome: WalletMockOutcome): Error {
    if (typeof outcome === 'object' && 'customError' in outcome) {
      return outcome.customError;
    }
    const type = outcome as WalletErrorType;
    // Use the same error messages that normalizeWalletError recognises so the
    // classification logic in the component under test sees the right category.
    const messageMap: Record<WalletErrorType, string> = {
      userRejected: 'User rejected the request',
      timeout: 'Wallet did not respond within 60s.',
      network: 'net::ERR_BAD_RESPONSE',
      staleEnvelope: 'tx_bad_seq',
      unsupported: 'Freighter wallet extension is not installed.',
      unknown: 'Unknown wallet error',
    };
    return new WalletError(messageMap[type] ?? 'Wallet error', type);
  }

  // ── Assemble the mock object ──────────────────────────────────────────────
  return {
    // Signals (read-only in production; writable here for direct test manipulation)
    publicKey: publicKey.asReadonly(),
    state: state.asReadonly(),
    isConnected: isConnected.asReadonly(),
    networkMismatch: networkMismatch.asReadonly(),
    expectedNetwork: expectedNetwork.asReadonly(),
    network: network.asReadonly(),
    xlmBalance: xlmBalance.asReadonly(),
    balanceError: balanceError.asReadonly(),
    error: error.asReadonly(),
    isFreighterInstalled: true,

    // Observable streams
    networkChanged$: networkChanged$.asObservable(),
    addressChanged$: addressChanged$.asObservable(),
    scopeChanged$: scopeChanged$.asObservable(),

    // Methods (vi.fn() spies)
    signTransaction,
    connect,
    getNetworkDetails,
    checkNetworkMatch,
    disconnect,
    startBalancePolling,
    stopBalancePolling,
    clearNetworkScopedData,

    // Test-only control API
    setSignOutcome,
    setConnectOutcome,
    setNetworkMismatch,
    simulateDisconnect,
    reset,
  };
}

export type WalletMock = ReturnType<typeof buildWalletMock>;
