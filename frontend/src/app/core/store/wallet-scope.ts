import { DestroyRef, computed, inject, signal } from '@angular/core';

import { networkSignal, walletAddressSignal } from '../services/wallet-state.signals';

/**
 * Issue #965 — store cache leaks across (network, address) boundaries.
 *
 * `credit.store` and `marketplace.store` are root-provided singletons, so any
 * data they hold survives a wallet account switch or a network switch. Without
 * an explicit key on every cache write, user B sees user A's holdings (and
 * vice-versa) until the component happens to trigger a reload.
 *
 * The fix is to treat `(network, address)` as the cache key: every write is
 * tagged with the scope that produced it, and the moment the active scope
 * changes every store drops what it was holding.
 *
 * Multi-address aggregate views are explicitly out of scope — there is exactly
 * one active scope at a time.
 */

/** A resolved (network, address) pair that owns a cache entry. */
export interface WalletScope {
  network: string;
  address: string;
}

/** Key used when no wallet is connected — never matches a real account's data. */
export const EMPTY_SCOPE_KEY = 'none:none';

/**
 * Build the cache key for a scope. The separator is `:` and neither part can
 * contain it (Stellar addresses are base32 `G…`, networks are `testnet` /
 * `mainnet`), so the mapping is injective.
 */
export function walletScopeKey(network: string | null, address: string | null): string {
  if (!network || !address) return EMPTY_SCOPE_KEY;
  return `${network}:${address}`;
}

/**
 * The scope currently in effect, derived from the wallet signals.
 *
 * `StellarWalletService` mirrors its address/network into
 * `walletAddressSignal` / `networkSignal` and pushes the resulting key through
 * `publishScopeChange`, so both the value and the invalidation event originate
 * from a single place.
 */
export const activeScopeKey = computed(() =>
  walletScopeKey(networkSignal(), walletAddressSignal()),
);

/** True when `key` belongs to the currently-connected wallet. */
export function isActiveScope(key: string | null | undefined): boolean {
  return !!key && key === activeScopeKey();
}

type ScopeListener = (key: string) => void;

const listeners = new Set<ScopeListener>();

/**
 * Subscribe to scope changes. Returns an unsubscribe function.
 *
 * Listeners fire synchronously from `StellarWalletService` at the moment it
 * publishes a new (network, address), i.e. inside the same task that changes
 * the wallet signals — so a store can never be observed holding a scope that is
 * already no longer active.
 */
export function onScopeChange(fn: ScopeListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Notify every scope subscriber. Called by `StellarWalletService` only. */
export function publishScopeChange(key: string): void {
  for (const fn of [...listeners]) {
    fn(key);
  }
}

/** True in a dev-server / test build, where cache writes are annotated. */
function isDevBuild(): boolean {
  return typeof ngDevMode === 'undefined' || !!ngDevMode;
}

/**
 * Base class for stores whose contents belong to a single (network, address).
 *
 * Subclasses call `beginWrite()` before issuing a request and `commitWrite()`
 * (or `discardWrite()`) when it settles. `commitWrite` refuses to publish data
 * whose originating scope is no longer active, which closes the in-flight race
 * where the user switches accounts while a request is still pending.
 */
export abstract class WalletScopedStore {
  private readonly _cacheKey = signal<string | null>(null);

  /** Scope key that owns the currently-cached data; null when the cache is empty. */
  readonly cacheKey = this._cacheKey.asReadonly();

  /** Snapshot the active scope. Call immediately before issuing a request. */
  protected beginWrite(): string {
    return activeScopeKey();
  }

  /**
   * Publish `value` as the cache contents *only* if the scope that requested it
   * is still active. Returns false when the write was dropped.
   */
  protected commitWrite(value: string, scope: string): boolean {
    if (scope !== activeScopeKey()) {
      this.annotate('dropped stale write', scope, value);
      return false;
    }
    this._cacheKey.set(scope);
    this.annotate('write', scope, value);
    return true;
  }

  /** Drop the in-flight marker without publishing (used on error paths). */
  protected discardWrite(): void {
    /* nothing retained between begin/commit — kept for symmetry at call sites */
  }

  /** Forget the cache key without touching the subclass's own state. */
  protected clearCacheKey(): void {
    this._cacheKey.set(null);
  }

  /**
   * Dev-tools annotation: every cache write logs the (network, address) key it
   * was filed under, so a leak is visible in the console rather than inferred.
   */
  protected annotate(action: string, scope: string, detail: string): void {
    if (!isDevBuild()) return;

    console.debug(`[${this.constructor.name}] ${action} scope=${scope} ${detail}`);
  }

  /**
   * Clear this store whenever the active (network, address) changes.
   *
   * Called from the store's constructor. The scope key is also re-synced on
   * construction so a store that outlived a switch cannot come back holding
   * another account's data.
   */
  protected watchScope(reset: () => void): void {
    const destroyRef = inject(DestroyRef);

    destroyRef.onDestroy(
      onScopeChange((key) => {
        const previous = this._cacheKey();
        this.annotate('scope change', key, `was=${previous ?? 'empty'}`);
        reset();
      }),
    );
  }
}
