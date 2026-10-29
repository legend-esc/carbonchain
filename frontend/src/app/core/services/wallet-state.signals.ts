import { computed, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';

/**
 * Signal-based wallet state, additive alongside StellarWalletService's
 * existing BehaviorSubject-based observables (walletAddress$, isConnected$,
 * network$) to avoid re-renders on emissions that don't change value.
 *
 * Migration path: components read the signal directly (no async pipe);
 * the toObservable() exports below keep existing subscribers working
 * unchanged until they're moved over.
 *
 * The toObservable() wrappers below are functions (not module-level consts)
 * because Angular v21 requires injection context for toObservable(), which
 * is not available at module load time. Callers invoke them lazily within
 * an injection context.
 */
export type WalletNetwork = 'testnet' | 'mainnet';
export const walletAddressSignal = signal<string | null>(null);
export const networkSignal = signal<WalletNetwork | null>(null);
export const isConnectedSignal = computed(() => walletAddressSignal() !== null);

/** Backward-compatible observables for components not yet migrated off async pipe. */
export function walletAddress$(): Observable<string | null> {
  return toObservable(walletAddressSignal);
}

export function isConnected$(): Observable<boolean> {
  return toObservable(isConnectedSignal);
}

export function network$(): Observable<WalletNetwork | null> {
  return toObservable(networkSignal);
}
