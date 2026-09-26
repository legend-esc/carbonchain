import { Injectable, signal, computed } from '@angular/core';
import { Subject } from 'rxjs';

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

@Injectable({ providedIn: 'root' })
export class StellarWalletService {
  private readonly _publicKey = signal<string | null>(null);
  private readonly _state = signal<WalletState>('disconnected');
  private readonly _error = signal<string | null>(null);
  private readonly _networkMismatch = signal(false);
  private readonly _expectedNetwork = signal<string>('testnet');
  private readonly _networkChanged$ = new Subject<void>();

  readonly publicKey = this._publicKey.asReadonly();
  readonly state = this._state.asReadonly();
  readonly error = this._error.asReadonly();
  readonly isConnected = computed(() => this._state() === 'connected');
  readonly networkMismatch = this._networkMismatch.asReadonly();
  readonly expectedNetwork = this._expectedNetwork.asReadonly();
  readonly networkChanged$ = this._networkChanged$.asObservable();

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
      this._publicKey.set(publicKey);
      this._state.set('connected');
      await this.checkNetworkMatch();
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
    if (this._networkMismatch()) {
      throw new Error('Network mismatch: please switch your wallet to the correct network.');
    }
    try {
      return await window.freighter!.signTransaction(xdr, { networkPassphrase });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaction signing failed.';
      this._error.set(msg);
      throw err;
    }
  }

  /** Returns the current network details from Freighter. */
  async getNetworkDetails(): Promise<{ network: string; networkPassphrase: string }> {
    if (!this.isFreighterInstalled) {
      throw new Error('Freighter wallet extension is not installed.');
    }
    return window.freighter!.getNetworkDetails();
  }

  /**
   * Checks whether the wallet's active network matches the expected network.
   * Sets `_networkMismatch` accordingly. Called automatically after connect().
   */
  async checkNetworkMatch(): Promise<void> {
    if (!this.isFreighterInstalled) return;
    try {
      const details = await window.freighter!.getNetworkDetails();
      const walletNet = details.network.toLowerCase();
      const expected = this._expectedNetwork().toLowerCase();
      this._networkMismatch.set(walletNet !== expected);
    } catch {
      // If we can't check, assume ok to avoid blocking the user unnecessarily.
      this._networkMismatch.set(false);
    }
  }

  /**
   * Clears any network-scoped cached data and disconnects the wallet.
   * Emits on `networkChanged$` so subscribers can react (e.g. clear local caches).
   */
  clearNetworkScopedData(): void {
    this.disconnect();
    this._networkChanged$.next();
  }

  /** Disconnects the wallet (clears local state — Freighter has no explicit disconnect API). */
  disconnect(): void {
    this._publicKey.set(null);
    this._state.set('disconnected');
    this._error.set(null);
    this._networkMismatch.set(false);
  }
}
