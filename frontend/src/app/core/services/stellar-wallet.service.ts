import { Injectable, computed, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { HttpClient } from '@angular/common/http';

import { WalletError, WalletErrorType, normalizeWalletError } from './wallet-errors';
import { networkSignal, walletAddressSignal } from './wallet-state.signals';
import { publishScopeChange } from '../store/wallet-scope';

// Freighter injects `window.freighter` — we declare a minimal interface here
// rather than pulling in the full SDK to keep the bundle lean.
interface FreighterApi {
  isConnected(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
  getNetworkDetails(): Promise<{ network: string; networkPassphrase: string }>;
}

interface XBullApi {
  connect(): Promise<{ publicKey: string }>;
  sign(params: { xdr: string; networkPassphrase?: string }): Promise<{ signedXDR: string }>;
  getPublicKey(): Promise<string>;
}

interface AlbedoApi {
  publicKey(params?: object): Promise<{ pubkey: string; network: string }>;
  tx(params: { xdr: string; network?: string; submit?: boolean }): Promise<{ signed_envelope_xdr: string; network: string }>;
}

declare global {
  interface Window {
    freighter?: FreighterApi;
    xBull?: XBullApi;
    albedo?: AlbedoApi;
  }
}

export type WalletProvider = 'freighter' | 'xbull' | 'albedo' | 'lobstr';

export interface WalletAdapter {
  id: WalletProvider;
  name: string;
  isInstalled(): boolean;
  installUrl: string;
  connect(): Promise<{ publicKey: string; network: string }>;
  signTransaction(xdr: string, networkPassphrase?: string): Promise<string>;
}

export type WalletState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type WalletNetwork = 'testnet' | 'mainnet';

// Issue #539: persist both the address and the network across reloads —
// restoring only the address left the app defaulting to the environment's
// network (mainnet in prod) regardless of which network the user was
// actually on.
const STORAGE_ADDRESS_KEY = 'cc_wallet_address';
const STORAGE_NETWORK_KEY = 'cc_wallet_network';
const STORAGE_PROVIDER_KEY = 'cc_wallet_provider';

/**
 * Issue #960 — Freighter can hang (locked extension, dead RPC) without ever
 * resolving or rejecting. Cap the wait so the user gets a "timed out" message
 * instead of an infinite spinner.
 */
export const SIGN_TIMEOUT_MS = 60_000;

@Injectable({ providedIn: 'root' })
export class StellarWalletService {
  private readonly _publicKey = signal<string | null>(this.loadStoredAddress());
  private readonly _state = signal<WalletState>(
    this.loadStoredAddress() ? 'connected' : 'disconnected',
  );
  private readonly _error = signal<string | null>(null);
  private readonly _expectedNetwork = signal<string>('testnet');
  private readonly _network = signal<WalletNetwork | null>(this.loadStoredNetwork());
  private readonly _networkMismatch = signal<boolean>(false);
  private readonly _selectedProvider = signal<WalletProvider>(this.loadStoredProvider());

  private readonly _networkChanged$ = new Subject<WalletNetwork | null>();
  private readonly _addressChanged$ = new Subject<string | null>();
  private readonly _scopeChanged$ = new Subject<string>();

  private readonly _xlmBalance = signal<number | null>(null);
  private readonly _balanceError = signal<string | null>(null);

  private balancePollTimer: ReturnType<typeof setInterval> | null = null;
  private _balancePollIntervalMs = 30_000;

  readonly publicKey = this._publicKey.asReadonly();
  readonly state = this._state.asReadonly();
  readonly error = this._error.asReadonly();
  readonly isConnected = computed(() => this._state() === 'connected');
  readonly expectedNetwork = this._expectedNetwork.asReadonly();

  /** Network (testnet/mainnet) the wallet last connected/persisted with. */
  readonly network = this._network.asReadonly();
  /** True when Freighter's live network no longer matches the persisted `network`. */
  readonly networkMismatch = this._networkMismatch.asReadonly();
  /** Currently selected wallet provider. */
  readonly selectedProvider = this._selectedProvider.asReadonly();

  /**
   * Issue #965 — emits whenever the network changes (including to `null` on
   * disconnect). Subscribers use it to clear network-scoped caches.
   */
  readonly networkChanged$ = this._networkChanged$.asObservable();
  /** Issue #965 — emits whenever the connected address changes. */
  readonly addressChanged$ = this._addressChanged$.asObservable();
  /**
   * Issue #965 — emits the new `<network>:<address>` key whenever either half
   * changes. This is the invalidation signal the store caches key on.
   */
  readonly scopeChanged$ = this._scopeChanged$.asObservable();

  /** Issue #965 — the live (network, address) key, mirrored into the shared signals. */
  readonly scopeKey = computed(() => this.scopeOf(this._network(), this._publicKey()));

  /** Latest fetched XLM balance (in stroops -> XLM). */
  readonly xlmBalance = this._xlmBalance.asReadonly();
  /** Optional fetch error message. */
  readonly balanceError = this._balanceError.asReadonly();

  /** Issue #966 — current balance polling interval in milliseconds. */
  readonly balancePollIntervalMs = computed(() => this._balancePollIntervalMs);

  /** Issue #966 — update the balance polling interval. */
  setBalancePollInterval(ms: number): void {
    this._balancePollIntervalMs = Math.max(1_000, ms);
    if (this.balancePollTimer && this.isConnected() && this.publicKey()) {
      this.stopBalancePolling();
      this.startBalancePolling();
    }
  }

  constructor() {
    // Mirror the restored session into the shared signals so wallet-scoped
    // caches start out keyed to the right (network, address) pair.
    this.publishScope();

    // A restored session (address survived reload) may no longer match
    // Freighter's actual network — verify it up front so the mismatch
    // warning shows immediately rather than after the next action.
    if (this._publicKey() && this.isFreighterInstalled) {
      void this.checkNetworkMatch();
    }
  }

  /** Returns true if the Freighter extension is installed in the browser. */
  get isFreighterInstalled(): boolean {
    return typeof window !== 'undefined' && !!window.freighter;
  }

  /** Connects to Freighter and retrieves the user's public key. */
  async connect(): Promise<string> {
    if (!this.isFreighterInstalled) {
      const err = new WalletError('Freighter wallet extension is not installed.', 'unsupported');
      this._error.set(err.message);
      this._state.set('error');
      throw err;
    }

    this._state.set('connecting');
    this._error.set(null);

    try {
      const connected = await window.freighter!.isConnected();
      if (!connected) {
        throw new WalletError(
          'Freighter is not connected. Please unlock your wallet.',
          'userRejected',
        );
      }

      const publicKey = await window.freighter!.getPublicKey();
      const { network } = await window.freighter!.getNetworkDetails();
      const walletNetwork = this.mapNetwork(network);

      this.setAddress(publicKey);
      this.setNetwork(walletNetwork);
      this._networkMismatch.set(false);
      this._state.set('connected');
      await this.checkNetworkMatch();
      this.persistSession(publicKey, walletNetwork);
      return publicKey;
    } catch (err) {
      const walletError = normalizeWalletError(err);
      this._error.set(walletError.message);
      this._state.set('error');
      throw walletError;
    }
  }

  /**
   * Signs a Stellar transaction XDR string using Freighter.
   *
   * Issue #960 — every failure is normalised into a `WalletError` carrying a
   * `type` (userRejected / timeout / network / unsupported / staleEnvelope)
   * so callers can show an actionable message and decide whether a retry with a
   * freshly-built envelope is worth attempting. The raw Freighter error is kept
   * on `cause` for logging.
   */
  async signTransaction(xdr: string, networkPassphrase?: string): Promise<string> {
    if (!this.isConnected()) {
      throw new WalletError('Wallet is not connected. Call connect() first.', 'unsupported');
    }
    if (this._networkMismatch()) {
      throw new WalletError(
        'Network mismatch: please switch your wallet to the correct network.',
        'unsupported',
      );
    }
    if (!this.isFreighterInstalled) {
      throw new WalletError('Freighter wallet extension is not installed.', 'unsupported');
    }

    try {
      return await this.withTimeout(
        window.freighter!.signTransaction(xdr, { networkPassphrase }),
        SIGN_TIMEOUT_MS,
      );
    } catch (err) {
      const walletError = normalizeWalletError(err);
      this._error.set(walletError.message);
      throw walletError;
    }
  }

  /**
   * Race a promise against a deadline. A Freighter that never settles (locked
   * extension, dead RPC) is reported as `timeout` instead of hanging the flow.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new WalletError(`Wallet did not respond within ${Math.round(ms / 1000)}s.`, 'timeout'),
        );
      }, ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** Map Horizon server from network passphrase. */
  private horizonForPassphrase(networkPassphrase: string): string {
    const p = networkPassphrase.toLowerCase();
    if (p.includes('test') && !p.includes('main')) {
      return 'https://horizon-testnet.stellar.org';
    }
    if (p.includes('public network') || p.includes('mainnet') || p.includes('stellar network')) {
      return 'https://horizon.stellar.org';
    }
    // Default to public/main.
    return 'https://horizon.stellar.org';
  }

  private async fetchXlmBalanceFromHorizon(horizonUrl: string, account: string): Promise<number> {
    // Fetch account data and read XLM balance.
    const res = await fetch(`${horizonUrl}/accounts/${account}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch XLM balance (Horizon ${res.status}).`);
    }
    const json = (await res.json()) as {
      balances?: Array<{ asset_type: string; balance: string }>;
    };

    const xlm = json.balances?.find((b) => b.asset_type === 'native');
    const stroops = xlm?.balance ?? '0';
    return Number(stroops) / 1_000_000;
  }

  /** Fetches the current XLM balance for an account from Horizon. */
  async getXlmBalance(publicKey: string): Promise<number> {
    const { networkPassphrase } = await this.getNetworkDetails();
    const horizonUrl = this.horizonForPassphrase(networkPassphrase);
    return this.fetchXlmBalanceFromHorizon(horizonUrl, publicKey);
  }

  /** Start polling XLM balance every 30 seconds while connected. */
  startBalancePolling(): void {
    if (this.balancePollTimer) return;
    if (!this.publicKey()) return;

    const tick = async () => {
      const pk = this.publicKey();
      if (!pk || !this.isConnected()) return;
      try {
        this._balanceError.set(null);
        const bal = await this.getXlmBalance(pk);
        // Guard against a stale write after disconnect: re-check the
        // connection/account before publishing the result.
        if (!this.isConnected() || this.publicKey() !== pk) return;
        this._xlmBalance.set(bal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to fetch XLM balance.';
        this._balanceError.set(msg);
      }
    };

    void tick();
    this.balancePollTimer = setInterval(() => void tick(), this._balancePollIntervalMs);
  }

  /** Stop XLM balance polling. */
  stopBalancePolling(): void {
    if (this.balancePollTimer) {
      clearInterval(this.balancePollTimer);
      this.balancePollTimer = null;
    }
  }

  /** Returns the current network details from Freighter. */
  async getNetworkDetails(): Promise<{ network: string; networkPassphrase: string }> {
    if (!this.isFreighterInstalled) {
      throw new WalletError('Freighter wallet extension is not installed.', 'unsupported');
    }
    return window.freighter!.getNetworkDetails();
  }

  /**
   * Checks whether the wallet's active network matches the expected network.
   * Sets `_networkMismatch` accordingly. Called automatically after connect().
   */
  async checkNetworkMatch(): Promise<boolean> {
    const stored = this._network();
    if (!stored || !this.isFreighterInstalled) {
      this._networkMismatch.set(false);
      return true;
    }
    try {
      const { network } = await window.freighter!.getNetworkDetails();
      const live = this.mapNetwork(network);
      const mismatch = live !== stored;
      this._networkMismatch.set(mismatch);
      return !mismatch;
    } catch {
      // Can't determine the live network (e.g. Freighter locked) — don't
      // block the UI on an inconclusive check.
      return true;
    }
  }

  /**
   * Returns all supported wallet adapters with live isInstalled() checks.
   */
  getAvailableAdapters(): WalletAdapter[] {
    // Capture `this` for use in adapter closures.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const freighterAdapter: WalletAdapter = {
      id: 'freighter',
      name: 'Freighter',
      installUrl: 'https://freighter.app',
      isInstalled: () => typeof window !== 'undefined' && !!window.freighter,
      async connect() {
        const connected = await window.freighter!.isConnected();
        if (!connected) {
          throw new WalletError(
            'Freighter is not connected. Please unlock your wallet.',
            'userRejected',
          );
        }
        const publicKey = await window.freighter!.getPublicKey();
        const { network } = await window.freighter!.getNetworkDetails();
        return { publicKey, network };
      },
      async signTransaction(xdr: string, networkPassphrase?: string) {
        return window.freighter!.signTransaction(xdr, { networkPassphrase });
      },
    };

    const xbullAdapter: WalletAdapter = {
      id: 'xbull',
      name: 'xBull',
      installUrl: 'https://xbull.app',
      isInstalled: () => typeof window !== 'undefined' && !!window.xBull,
      async connect() {
        const result = await window.xBull!.connect();
        return { publicKey: result.publicKey, network: 'testnet' };
      },
      async signTransaction(xdr: string, networkPassphrase?: string) {
        const result = await window.xBull!.sign({ xdr, networkPassphrase });
        return result.signedXDR;
      },
    };

    const albedoAdapter: WalletAdapter = {
      id: 'albedo',
      name: 'Albedo',
      installUrl: 'https://albedo.link',
      isInstalled: () => typeof window !== 'undefined' && !!window.albedo,
      async connect() {
        const result = await window.albedo!.publicKey();
        return { publicKey: result.pubkey, network: result.network ?? 'testnet' };
      },
      async signTransaction(xdr: string, networkPassphrase?: string) {
        const result = await window.albedo!.tx({ xdr, network: networkPassphrase, submit: false });
        return result.signed_envelope_xdr;
      },
    };

    const lobstrAdapter: WalletAdapter = {
      id: 'lobstr',
      name: 'Lobstr',
      installUrl: 'https://lobstr.co',
      isInstalled: () => false,
      async connect() {
        throw new WalletError(
          'Lobstr WalletConnect is not yet available in-browser. Install the Lobstr app.',
          'unsupported',
        );
      },
      async signTransaction(_xdr: string, _networkPassphrase?: string) {
        throw new WalletError(
          'Lobstr WalletConnect is not yet available in-browser. Install the Lobstr app.',
          'unsupported',
        );
      },
    };

    return [freighterAdapter, xbullAdapter, albedoAdapter, lobstrAdapter];
  }

  /**
   * Connect using a specific wallet provider.
   * Sets the selected provider, establishes the connection, and persists the session.
   */
  async connectWithProvider(provider: WalletProvider): Promise<string> {
    this._selectedProvider.set(provider);
    this.persistProvider(provider);

    if (provider === 'freighter') {
      return this.connect();
    }

    this._state.set('connecting');
    this._error.set(null);

    try {
      const adapters = this.getAvailableAdapters();
      const adapter = adapters.find((a) => a.id === provider);
      if (!adapter) {
        throw new WalletError(`Unsupported wallet provider: ${provider}`, 'unsupported');
      }

      if (provider === 'lobstr') {
        throw new WalletError(
          'Lobstr WalletConnect is not yet available in-browser. Install the Lobstr app.',
          'unsupported',
        );
      }

      const { publicKey, network } = await adapter.connect();
      const walletNetwork = this.mapNetwork(network);

      this.setAddress(publicKey);
      this.setNetwork(walletNetwork);
      this._networkMismatch.set(false);
      this._state.set('connected');
      this.persistSession(publicKey, walletNetwork);
      return publicKey;
    } catch (err) {
      const walletError = normalizeWalletError(err);
      this._error.set(walletError.message);
      this._state.set('error');
      throw walletError;
    }
  }

  /**
   * Clears any network-scoped cached data and disconnects the wallet.
   *
   * Emits on `networkChanged$` / `addressChanged$` / `scopeChanged$` so
   * subscribers can drop caches keyed to the old (network, address).
   */
  clearNetworkScopedData(): void {
    this.disconnect();
    this._networkChanged$.next(null);
  }

  /** Disconnects the wallet (clears local state — Freighter has no explicit disconnect API). */
  disconnect(): void {
    this.stopBalancePolling();

    this.setAddress(null);
    this._state.set('disconnected');
    this._error.set(null);
    this._networkMismatch.set(false);
    this._xlmBalance.set(null);
    this._balanceError.set(null);
    this.setNetwork(null);
    this.clearPersistedSession();
  }

  /** Maps Freighter's raw network string ('PUBLIC', 'TESTNET', ...) to our two-value model. */
  private mapNetwork(freighterNetwork: string): WalletNetwork {
    return freighterNetwork.toUpperCase() === 'PUBLIC' ? 'mainnet' : 'testnet';
  }

  // ── Scope plumbing (issue #965) ───────────────────────────────────────────

  private scopeOf(network: WalletNetwork | null, address: string | null): string {
    return network && address ? `${network}:${address}` : 'none:none';
  }

  private setAddress(address: string | null): void {
    if (this._publicKey() === address) return;
    this._publicKey.set(address);
    this._addressChanged$.next(address);
    this.publishScope();
  }

  private setNetwork(network: WalletNetwork | null): void {
    if (this._network() === network) return;
    this._network.set(network);
    this._networkChanged$.next(network);
    this.publishScope();
  }

  /** Mirror the current scope into the shared signals and fire `scopeChanged$`. */
  private publishScope(): void {
    const key = this.scopeKey();
    const prev = this.scopeOf(networkSignal(), walletAddressSignal());
    walletAddressSignal.set(this._publicKey());
    networkSignal.set(this._network());
    if (key === prev) return;
    // Issue #965: notify the (network, address)-keyed stores synchronously so
    // none of them can be observed holding the previous account's data.
    publishScopeChange(key);
    this._scopeChanged$.next(key);
  }

  private persistSession(publicKey: string, network: WalletNetwork): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_ADDRESS_KEY, publicKey);
    localStorage.setItem(STORAGE_NETWORK_KEY, network);
  }

  private persistProvider(provider: WalletProvider): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_PROVIDER_KEY, provider);
  }

  private clearPersistedSession(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_ADDRESS_KEY);
    localStorage.removeItem(STORAGE_NETWORK_KEY);
    localStorage.removeItem(STORAGE_PROVIDER_KEY);
  }

  private loadStoredAddress(): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(STORAGE_ADDRESS_KEY);
  }

  private loadStoredNetwork(): WalletNetwork | null {
    if (typeof localStorage === 'undefined') return null;
    const stored = localStorage.getItem(STORAGE_NETWORK_KEY);
    return stored === 'mainnet' || stored === 'testnet' ? stored : null;
  }

  private loadStoredProvider(): WalletProvider {
    if (typeof localStorage === 'undefined') return 'freighter';
    const stored = localStorage.getItem(STORAGE_PROVIDER_KEY);
    const valid: WalletProvider[] = ['freighter', 'xbull', 'albedo', 'lobstr'];
    return valid.includes(stored as WalletProvider)
      ? (stored as WalletProvider)
      : 'freighter';
  }
}

export type { WalletError, WalletErrorType };
