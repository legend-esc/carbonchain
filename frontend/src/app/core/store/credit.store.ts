import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SwUpdate } from '@angular/service-worker';
import { CreditMetadata, CreditStatus } from '@shared';
import { ApiService } from '../services/api.service';
import { ToastService } from '../services/toast.service';
import { WalletScopedStore } from './wallet-scope';

export type LoadingState = 'idle' | 'loading' | 'loaded' | 'error';

@Injectable({ providedIn: 'root' })
export class CreditStore extends WalletScopedStore {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly swUpdate = inject(SwUpdate, { optional: true });

  // ── Private writable signals ───────────────────────────────────────────────

  private readonly _credits = signal<CreditMetadata[]>([]);
  private readonly _loadingState = signal<LoadingState>('idle');
  private readonly _error = signal<string | null>(null);
  private readonly _selectedId = signal<string | null>(null);

  constructor() {
    super();
    // Issue #965: the connected (network, address) owns everything cached here.
    // Switching account or network drops the previous account's rows before any
    // component can render them.
    this.watchScope(() => this.reset());
  }

  // ── Public readonly signals ────────────────────────────────────────────────

  readonly credits = this._credits.asReadonly();
  readonly loadingState = this._loadingState.asReadonly();
  readonly error = this._error.asReadonly();
  readonly selectedId = this._selectedId.asReadonly();

  // ── Derived / computed ─────────────────────────────────────────────────────

  readonly isLoading = computed(() => this._loadingState() === 'loading');

  readonly selected = computed(
    () => this._credits().find((c) => c.id === this._selectedId()) ?? null,
  );

  readonly totalTonnes = computed(() =>
    this._credits().reduce((sum, c) => sum + BigInt(c.tonnes), BigInt(0)),
  );

  readonly activeCredits = computed(() =>
    this._credits().filter((c) => c.status === CreditStatus.Active),
  );

  readonly retiredCredits = computed(() =>
    this._credits().filter((c) => c.status === CreditStatus.Retired),
  );

  readonly creditsByProject = computed(() => {
    const map = new Map<string, CreditMetadata[]>();
    for (const credit of this._credits()) {
      const list = map.get(credit.project_id) ?? [];
      list.push(credit);
      map.set(credit.project_id, list);
    }
    return map;
  });

  // ── Actions ────────────────────────────────────────────────────────────────

  /** Load all credit IDs for a project, then fetch each credit's metadata. */
  async loadByProject(projectId: string): Promise<void> {
    const scope = this.beginWrite();
    this._loadingState.set('loading');
    this._error.set(null);

    try {
      const ids = await firstValueFrom(this.api.listCreditsByProject(projectId));
      const credits = await Promise.all(ids.map((id) => firstValueFrom(this.api.getCredit(id))));
      if (!this.commitWrite(`project=${projectId}`, scope)) {
        this._loadingState.set('idle');
        return;
      }
      this._credits.set(credits);
      this._loadingState.set('loaded');
    } catch (err) {
      this.discardWrite();
      const msg = err instanceof Error ? err.message : 'Failed to load credits.';
      this._error.set(msg);
      this._loadingState.set('error');
    }
  }

  /**
   * Load all credits owned by an account (the wallet public key) via the
   * paginated owner endpoint, then fetch each credit's metadata.
   *
   * Issue #965 — the result is filed under the active `(network, address)` and
   * filtered to the requested owner, so a response that races an account switch
   * can never surface another account's holdings.
   */
  async loadByOwner(owner: string): Promise<void> {
    const scope = this.beginWrite();
    this._loadingState.set('loading');
    this._error.set(null);

    try {
      const limit = 50;
      const allIds: string[] = [];
      let offset = 0;

      // The owner endpoint is paginated; collect pages until a short page.
      for (let page = 0; page < 100; page++) {
        const res = await firstValueFrom(this.api.listCreditsByOwner(owner, offset, limit));
        allIds.push(...res.data);
        if (res.data.length < limit) break;
        offset += limit;
      }

      const fetched = await Promise.all(allIds.map((id) => firstValueFrom(this.api.getCredit(id))));
      // Defence in depth: the API is the authority, but never let a row owned
      // by somebody else into an account-scoped cache.
      const credits = fetched.filter((c) => c.owner === owner);

      if (!this.commitWrite(`owner=${owner} rows=${credits.length}`, scope)) {
        this._loadingState.set('idle');
        return;
      }
      this._credits.set(credits);
      this._loadingState.set('loaded');
    } catch (err) {
      this.discardWrite();
      const msg = err instanceof Error ? err.message : 'Failed to load credits.';
      this._error.set(msg);
      this._loadingState.set('error');
    }
  }

  /** Load a single credit and merge it into the store. */
  async loadOne(id: string): Promise<void> {
    const scope = this.beginWrite();
    this._loadingState.set('loading');
    this._error.set(null);

    try {
      const credit = await firstValueFrom(this.api.getCredit(id));
      if (!this.commitWrite(`credit=${id}`, scope)) {
        this._loadingState.set('idle');
        return;
      }
      this._credits.update((list) => {
        const idx = list.findIndex((c) => c.id === id);
        return idx >= 0
          ? [...list.slice(0, idx), credit, ...list.slice(idx + 1)]
          : [...list, credit];
      });
      this._loadingState.set('loaded');
    } catch (err) {
      this.discardWrite();
      const msg = err instanceof Error ? err.message : `Failed to load credit ${id}.`;
      this._error.set(msg);
      this._loadingState.set('error');
    }
  }

  /** Set the currently selected credit id. */
  select(id: string | null): void {
    this._selectedId.set(id);
  }

  /** Clear all credits from the store. */
  reset(): void {
    this._credits.set([]);
    this._loadingState.set('idle');
    this._error.set(null);
    this._selectedId.set(null);
    this.clearCacheKey();
  }

  /**
   * Trigger a service-worker update check to bust the `credits-api` cache.
   *
   * Call this after any mutation (issue, retire, split) so the next
   * `loadByProject` / `loadOne` fetches fresh data from the network rather
   * than the stale SW cache.
   *
   * The `credits-api` dataGroup is configured with `strategy: 'freshness'`
   * in ngsw-config.json, so a `checkForUpdate()` forces the SW to revalidate
   * all cached responses for `/api/v1/credits*` on the next request.
   *
   * This is a best-effort call — if SwUpdate is unavailable (dev mode, tests)
   * it is silently skipped.
   */
  async invalidateSwCache(): Promise<void> {
    if (!this.swUpdate?.isEnabled) {
      return;
    }
    try {
      await this.swUpdate.checkForUpdate();
    } catch {
      // Non-fatal: SW cache invalidation failure should not surface as an error
    }
  }

  /**
   * Optimistically split a credit into two child credits.
   * On success, replaces temporary IDs with real IDs from the API response.
   * On failure, rolls back the optimistic update and shows an error toast.
   */
  async splitCredit(creditId: string, splitTonnes: string, token: string): Promise<{ childCredit1: string; childCredit2: string }> {
    const scope = this.beginWrite();
    const parent = this._credits().find((c) => c.id === creditId);
    if (!parent) {
      this.discardWrite();
      this.toast.showError('Credit not found');
      throw new Error('Credit not found');
    }

    const splitTonnesBigInt = BigInt(splitTonnes);
    const parentTonnesBigInt = BigInt(parent.tonnes);
    const child2Tonnes = (parentTonnesBigInt - splitTonnesBigInt).toString();

    // Generate temporary IDs for optimistic display
    const tempChild1Id = `temp-split-${Date.now()}-a`;
    const tempChild2Id = `temp-split-${Date.now()}-b`;

    const child1: CreditMetadata = {
      ...parent,
      id: tempChild1Id,
      tonnes: splitTonnes,
      status: CreditStatus.Active,
    };
    const child2: CreditMetadata = {
      ...parent,
      id: tempChild2Id,
      tonnes: child2Tonnes,
      status: CreditStatus.Active,
    };

    // Optimistic update: add children, mark parent as retired
    this._credits.update((list) => {
      return [
        ...list.map((c) => (c.id === creditId ? { ...c, status: CreditStatus.Retired } : c)),
        child1,
        child2,
      ];
    });

    try {
      const response = await firstValueFrom(this.api.splitCredit(creditId, splitTonnes, token));

      // Issue #965 — if the account changed mid-flight the optimistic rows
      // belong to the previous account, so leave the (already cleared) store
      // alone rather than writing real IDs into the new account's cache.
      if (this.cacheKey() !== scope) {
        this.discardWrite();
        return response;
      }
      this.annotate('split reconcile', scope, `credit=${creditId}`);

      // Reconcile: replace temporary IDs with real IDs
      this._credits.update((list) =>
        list.map((c) => {
          if (c.id === tempChild1Id) {
            return { ...c, id: response.childCredit1 };
          }
          if (c.id === tempChild2Id) {
            return { ...c, id: response.childCredit2 };
          }
          return c;
        }),
      );

      // Invalidate SW cache so the next load fetches fresh data from network
      await this.invalidateSwCache();

      this.toast.showSuccess('Credit split successfully');
      return response;
    } catch (err) {
      this.discardWrite();
      // Rollback: remove children, restore parent status
      this._credits.update((list) =>
        list
          .filter((c) => c.id !== tempChild1Id && c.id !== tempChild2Id)
          .map((c) => (c.id === creditId ? { ...c, status: CreditStatus.Active } : c)),
      );

      const msg = err instanceof Error ? err.message : 'Failed to split credit.';
      this._error.set(msg);
      this.toast.showError(msg);
      throw err;
    }
  }

  /** POST /credits/merge — merge multiple credits into one */
  async mergeCredits(creditIds: string[], token: string): Promise<{ mergedCreditId: string }> {
    const scope = this.beginWrite();
    try {
      const response = await firstValueFrom(this.api.mergeCredits(creditIds, token));

      // Issue #965 — if the account changed mid-flight the optimistic rows
      // belong to the previous account, so leave the (already cleared) store
      // alone rather than writing real IDs into the new account's cache.
      if (this.cacheKey() !== scope) {
        this.discardWrite();
        return response;
      }
      this.annotate('merge reconcile', scope, `credits=${creditIds.join(',')}`);

      // Remove merged credits from local store
      this._credits.update((list) =>
        list.filter((c) => !creditIds.includes(c.id)),
      );

      await this.invalidateSwCache();

      this.toast.showSuccess('Credits merged successfully');
      return response;
    } catch (err) {
      this.discardWrite();
      const msg = err instanceof Error ? err.message : 'Failed to merge credits.';
      this._error.set(msg);
      this.toast.showError(msg);
      throw err;
    }
  }
}
