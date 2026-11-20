import { Injectable, computed, signal } from '@angular/core';

import { Offer } from '@shared';

/**
 * Issue #958 — watchlist with client-side alerts.
 *
 * A buyer picks a project (or credit) and a target price; every time the
 * marketplace loads, the store compares the new listings against the targets and
 * raises an alert for anything at or below the threshold.
 *
 * Scope: client-side only. No server push, no email — consistent with the rest
 * of Phase 3. Persistence is localStorage so the list survives reloads.
 */

const STORAGE_KEY = 'cc_watchlist';

export interface WatchEntry {
  /** Project id, credit id, or 'market' — whatever the chart series is keyed on. */
  key: string;
  /** Human label shown in the watchlist UI. */
  label: string;
  /** Alert when a listing for `key` is priced at or below this (base units). */
  targetPrice: number | null;
  addedAt: number;
}

export interface WatchAlert {
  key: string;
  label: string;
  offer: Offer;
  targetPrice: number;
  /** Distance below target, as a fraction of the target (0 = exactly at target). */
  discount: number;
}

@Injectable({ providedIn: 'root' })
export class WatchlistStore {
  private readonly _entries = signal<WatchEntry[]>(this.read());
  /** Alerts raised by the most recent `evaluate()` call. */
  private readonly _alerts = signal<WatchAlert[]>([]);

  readonly entries = this._entries.asReadonly();
  readonly alerts = this._alerts.asReadonly();
  readonly isEmpty = computed(() => this._entries().length === 0);
  readonly alertCount = computed(() => this._alerts().length);

  /** True when `key` is already being watched. */
  isWatching(key: string): boolean {
    return this._entries().some((e) => e.key === key);
  }

  /** The watch entry for `key`, if any. */
  entryFor(key: string): WatchEntry | null {
    return this._entries().find((e) => e.key === key) ?? null;
  }

  /** Add a key to the watchlist. Re-adding updates the target instead. */
  watch(key: string, label: string, targetPrice: number | null = null): void {
    if (!key) return;
    this._entries.update((list) => {
      const existing = list.find((e) => e.key === key);
      if (existing) {
        return list.map((e) =>
          e.key === key
            ? { ...e, label: label || e.label, targetPrice: targetPrice ?? e.targetPrice }
            : e,
        );
      }
      return [...list, { key, label: label || key, targetPrice, addedAt: Date.now() }];
    });
    this.persist();
  }

  /** Stop watching a key and drop any alert it had raised. */
  unwatch(key: string): void {
    this._entries.update((list) => list.filter((e) => e.key !== key));
    this._alerts.update((list) => list.filter((a) => a.key !== key));
    this.persist();
  }

  /** Set (or clear, with null) the target price for a watched key. */
  setTargetPrice(key: string, targetPrice: number | null): void {
    this._entries.update((list) => list.map((e) => (e.key === key ? { ...e, targetPrice } : e)));
    this.persist();
  }

  /**
   * Compare freshly loaded listings against the watchlist.
   *
   * `offersOf` maps an offer onto the key the watchlist uses (its project, or the
   * offer id when the listing exposes no project). Returns the alerts raised.
   * Re-running replaces the previous alert set rather than accumulating, so an
   * alert never goes stale while the user is looking at the page.
   */
  evaluate(
    offers: readonly Offer[],
    offersOf: (offer: Offer) => string = defaultOfferKey,
  ): WatchAlert[] {
    const targets = new Map(
      this._entries()
        .filter((e): e is WatchEntry & { targetPrice: number } => e.targetPrice !== null)
        .map((e) => [e.key, e]),
    );

    const alerts: WatchAlert[] = [];
    for (const offer of offers) {
      const entry = targets.get(offersOf(offer));
      if (!entry) continue;

      const price = priceOf(offer);
      if (price === null || price > entry.targetPrice) continue;

      alerts.push({
        key: entry.key,
        label: entry.label,
        offer,
        targetPrice: entry.targetPrice,
        discount:
          entry.targetPrice > 0 ? Math.max(0, (entry.targetPrice - price) / entry.targetPrice) : 0,
      });
    }

    this._alerts.set(alerts);
    return alerts;
  }

  /** Dismiss the current alerts without unwatching. */
  clearAlerts(): void {
    this._alerts.set([]);
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._entries()));
    } catch {
      // Private-mode / quota failures are non-fatal: the watchlist stays in memory.
    }
  }

  private read(): WatchEntry[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is WatchEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as WatchEntry).key === 'string' &&
          typeof (e as WatchEntry).label === 'string',
      );
    } catch {
      return [];
    }
  }
}

/**
 * Price of an offer in the payment asset's base units.
 *
 * `price_amount` is the current field; `price_xlm` is the legacy XLM-only one.
 */
export function priceOf(offer: Offer): number | null {
  const raw = offer.price_amount ?? offer.price_xlm;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Default mapping from an offer to a watchlist key. */
export function defaultOfferKey(offer: Offer): string {
  return (offer as { project_id?: string }).project_id ?? offer.credit_id;
}
