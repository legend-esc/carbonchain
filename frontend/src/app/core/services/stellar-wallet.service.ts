import { Injectable, signal, computed } from '@angular/core';

import { firstValueFrom } from 'rxjs';

import { HttpClient } from '@angular/common/http';

// Freighter injects `window.freighter` — we declare a minimal interface here
// rather than pulling in the full SDK to keep the bundle lean.
interface FreighterApi {
  isConnected(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
  getNetworkDetails(): Promise<{ network: string; networkPassphrase: string }>;
}

declare global {
  interface Window {
    freighter?: FreighterApi;
  }
}

export type WalletState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type WalletNetwork = 'testnet' | 'mainnet';

// Issue #539: persist both the address and the network across reloads —
// restoring only the address left the app defaulting to the environment's
// network (mainnet in prod) regardless of which network the user was
// actually on.
const STORAGE_ADDRESS_KEY = 'cc_wallet_address';
const STORAGE_NETWORK_KEY = 'cc_wallet_network';

@Injectable({ providedIn: 'root' })
export class StellarWalletService {
  private readonly _publicKey = signal<string | null>(this.loadStoredAddress());
  private readonly _state = signal<WalletState>(
    this.loadStoredAddress() ? 'connected' : 'disconnected',
  );
  private readonly _error = signal<string | null>(null);
  private readonly _network = signal<WalletNetwork | null>(this.loadStoredNetwork());
  private readonly _networkMismatch = signal<boolean>(false);

  private readonly _xlmBalance = signal<number | null>(null);
  private readonly _balanceError = signal<string | null>(null);

  private balancePollTimer: ReturnType<typeof setInterval> | null = null;

  readonly publicKey = this._publicKey.asReadonly();
  readonly state = this._state.asReadonly();
  readonly error = this._error.asReadonly();
  readonly isConnected = computed(() => this._state() === 'connected');

  /** Network (testnet/mainnet) the wallet last connected/persisted with. */
  readonly network = this._network.asReadonly();
  /** True when Freighter's live network no longer matches the persisted `network`. */
  readonly networkMismatch = this._networkMismatch.asReadonly();

  /** Latest fetched XLM balance (in stroops -> XLM). */
  readonly xlmBalance = this._xlmBalance.asReadonly();
  /** Optional fetch error message. */
  readonly balanceError = this._balanceError.asReadonly();

  constructor() {
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
      const msg = 'Freighter wallet extension is not installed.';
      this._error.set(msg);
      this._state.set('error');
      throw new Error(msg);
    }

    this._state.set('connecting');
    this._error.set(null);

    try {
      const connected = await window.freighter!.isConnected();
      if (!connected) {
        throw new Error('Freighter is not connected. Please unlock your wallet.');
      }

      const publicKey = await window.freighter!.getPublicKey();
      const { network } = await window.freighter!.getNetworkDetails();
      const walletNetwork = this.mapNetwork(network);

      this._publicKey.set(publicKey);
      this._network.set(walletNetwork);
      this._networkMismatch.set(false);
      this._state.set('connected');
      this.persistSession(publicKey, walletNetwork);
      return publicKey;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to connect to Freighter.';
      this._error.set(msg);
      this._state.set('error');
      throw err;
    }
  }

  /** Signs a Stellar transaction XDR string using Freighter. */
  async signTransaction(xdr: string, networkPassphrase?: string): Promise<string> {
    if (!this.isConnected()) {
      throw new Error('Wallet is not connected. Call connect() first.');
    }

    try {
      return await window.freighter!.signTransaction(xdr, { networkPassphrase });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction signing failed.';
      this._error.set(msg);
      throw err;
    }
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
      if (!pk) return;
      try {
        this._balanceError.set(null);
        const bal = await this.getXlmBalance(pk);
        this._xlmBalance.set(bal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to fetch XLM balance.';
        this._balanceError.set(msg);
      }
    };

    void tick();
    this.balancePollTimer = setInterval(() => void tick(), 30_000);
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
      throw new Error('Freighter wallet extension is not installed.');
    }
    return window.freighter!.getNetworkDetails();
  }

  /** Disconnects the wallet (clears local state — Freighter has no explicit disconnect API). */
  disconnect(): void {
    this.stopBalancePolling();

    this._publicKey.set(null);
    this._state.set('disconnected');
    this._error.set(null);
    this._xlmBalance.set(null);
    this._balanceError.set(null);
    this._network.set(null);
    this._networkMismatch.set(false);
    this.clearPersistedSession();
  }

  /**
   * Re-checks Freighter's live network against the persisted `network` and
   * updates `networkMismatch` accordingly. Returns true when they match.
   *
   * Call this after a reload (a restored session may be stale) and whenever
   * the user might have switched networks inside Freighter directly.
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

  /** Maps Freighter's raw network string ('PUBLIC', 'TESTNET', ...) to our two-value model. */
  private mapNetwork(freighterNetwork: string): WalletNetwork {
    return freighterNetwork.toUpperCase() === 'PUBLIC' ? 'mainnet' : 'testnet';
  }

  private persistSession(publicKey: string, network: WalletNetwork): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_ADDRESS_KEY, publicKey);
    localStorage.setItem(STORAGE_NETWORK_KEY, network);
  }

  private clearPersistedSession(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_ADDRESS_KEY);
    localStorage.removeItem(STORAGE_NETWORK_KEY);
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
}
