import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CreditMetadata, CreditStatus } from '@shared';
import { ApiService } from '../services/api.service';

export type LoadingState = 'idle' | 'loading' | 'loaded' | 'error';

@Injectable({ providedIn: 'root' })
export class CreditStore {
  private readonly api = inject(ApiService);

  // ── Private writable signals ───────────────────────────────────────────────

  private readonly _credits = signal<CreditMetadata[]>([]);
  private readonly _loadingState = signal<LoadingState>('idle');
  private readonly _error = signal<string | null>(null);
  private readonly _selectedId = signal<string | null>(null);

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
    this._loadingState.set('loading');
    this._error.set(null);

    try {
      const ids = await firstValueFrom(this.api.listCreditsByProject(projectId));
      const credits = await Promise.all(ids.map((id) => firstValueFrom(this.api.getCredit(id))));
      this._credits.set(credits);
      this._loadingState.set('loaded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load credits.';
      this._error.set(msg);
      this._loadingState.set('error');
    }
  }

  /** Load a single credit and merge it into the store. */
  async loadOne(id: string): Promise<void> {
    this._loadingState.set('loading');
    this._error.set(null);

    try {
      const credit = await firstValueFrom(this.api.getCredit(id));
      this._credits.update((list) => {
        const idx = list.findIndex((c) => c.id === id);
        return idx >= 0
          ? [...list.slice(0, idx), credit, ...list.slice(idx + 1)]
          : [...list, credit];
      });
      this._loadingState.set('loaded');
    } catch (err) {
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
  }

  /**
   * Split a credit into two child credits.
   * Calls POST /credits/:id/split.
   * On success, removes the parent credit from the store and adds the two
   * child credits (re-fetched individually).
   *
   * @param creditId  The parent credit ID to split.
   * @param splitTonnes  Tonnes for the first child (as BigInt-compatible string).
   * @param token  JWT for authentication.
   * @returns IDs of both child credits.
   */
  async splitCredit(
    creditId: string,
    splitTonnes: string,
    token: string,
  ): Promise<{ childCredit1: string; childCredit2: string }> {
    this._loadingState.set('loading');
    this._error.set(null);
    try {
      const result = await firstValueFrom(
        this.api.splitCredit(creditId, splitTonnes, token),
      );
      // Remove the parent and load both children into the store.
      this._credits.update((list) => list.filter((c) => c.id !== creditId));
      const [child1, child2] = await Promise.all([
        firstValueFrom(this.api.getCredit(result.childCredit1)),
        firstValueFrom(this.api.getCredit(result.childCredit2)),
      ]);
      this._credits.update((list) => [...list, child1, child2]);
      this._loadingState.set('loaded');
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed to split credit ${creditId}.`;
      this._error.set(msg);
      this._loadingState.set('error');
      throw err;
    }
  }

  /**
   * Merge multiple credits into one.
   * Calls POST /credits/merge.
   * On success, removes the source credits from the store and adds the
   * merged credit (re-fetched by ID).
   *
   * @param creditIds  IDs of credits to merge (must share methodology, vintage, issuer).
   * @param token  JWT for authentication.
   * @returns ID of the new merged credit.
   */
  async mergeCredits(
    creditIds: string[],
    token: string,
  ): Promise<{ mergedCreditId: string }> {
    this._loadingState.set('loading');
    this._error.set(null);
    try {
      const result = await firstValueFrom(
        this.api.mergeCredits(creditIds, token),
      );
      // Remove source credits and add the merged one.
      this._credits.update((list) => list.filter((c) => !creditIds.includes(c.id)));
      const merged = await firstValueFrom(this.api.getCredit(result.mergedCreditId));
      this._credits.update((list) => [...list, merged]);
      this._loadingState.set('loaded');
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to merge credits.';
      this._error.set(msg);
      this._loadingState.set('error');
      throw err;
    }
  }
}
