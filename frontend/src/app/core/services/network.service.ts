import { Injectable, computed, signal } from '@angular/core';
import { WalletNetwork } from './stellar-wallet.service';

/**
 * Issue #1355 — NetworkService owns the network-switch modal state and
 * provides human-readable metadata for each supported Stellar network.
 *
 * The service is intentionally thin: `StellarWalletService` remains the
 * single source of truth for the connected wallet's network. This service
 * only carries UI-level concerns (modal open/close, network labels, colors,
 * faucet URLs) so components stay declarative.
 */
export interface NetworkMeta {
  id: WalletNetwork;
  label: string;
  /** Tailwind-compatible CSS class suffix used by the badge. */
  colorClass: string;
  /** Faucet URL — only defined for non-production networks. */
  faucetUrl?: string;
  /** Short warning shown inside the switch modal. */
  warning?: string;
}

export const NETWORK_META: Record<WalletNetwork, NetworkMeta> = {
  mainnet: {
    id: 'mainnet',
    label: 'Mainnet',
    colorClass: 'mainnet',
  },
  testnet: {
    id: 'testnet',
    label: 'Testnet',
    colorClass: 'testnet',
    faucetUrl: 'https://friendbot.stellar.org',
    warning: 'Testnet — transactions use test XLM and have no real-world value.',
  },
  futurenet: {
    id: 'futurenet',
    label: 'Futurenet',
    colorClass: 'futurenet',
    faucetUrl: 'https://friendbot-futurenet.stellar.org',
    warning: 'Futurenet — experimental preview network. Data may be reset at any time.',
  },
};

export const ALL_NETWORKS: NetworkMeta[] = Object.values(NETWORK_META);

@Injectable({ providedIn: 'root' })
export class NetworkService {
  private readonly _modalOpen = signal(false);

  /** Whether the network-switch modal is currently visible. */
  readonly modalOpen = this._modalOpen.asReadonly();

  /** Open the network-switch modal. */
  openModal(): void {
    this._modalOpen.set(true);
  }

  /** Close the network-switch modal. */
  closeModal(): void {
    this._modalOpen.set(false);
  }

  /** Meta record for a given network id, falls back to testnet. */
  metaFor(network: WalletNetwork | null): NetworkMeta {
    return network ? (NETWORK_META[network] ?? NETWORK_META.testnet) : NETWORK_META.testnet;
  }
}
