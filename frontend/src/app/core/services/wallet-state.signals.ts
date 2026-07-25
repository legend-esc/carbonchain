import { computed, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';

/**
 * Signal-based wallet state, additive alongside StellarWalletService's
 * existing BehaviorSubject-based observables (walletAddress$, isConnected$,
 * network$) to avoid re-renders on emissions that don't change value.
 *
 * Migration path: components read the signal directly (no async pipe);
 * the toObservable() exports below keep existing subscribers working
 * unchanged until they're moved over.
 */
export const walletAddressSignal = signal<string | null>(null);
export const networkSignal = signal<string | null>(null);
export const isConnectedSignal = computed(() => walletAddressSignal() !== null);

/** Backward-compatible observables for components not yet migrated off async pipe. */
export const walletAddress$ = toObservable(walletAddressSignal);
export const isConnected$ = toObservable(isConnectedSignal);
export const network$ = toObservable(networkSignal);
