import { Injectable, signal } from '@angular/core';
import { CreditMetadata } from '@shared';

const STORAGE_KEY = 'retire.draft.v1';

/** Drafts older than this are discarded on restore (ms). */
export const DRAFT_TTL_MS = 30 * 60 * 1000;

const DRAFT_VERSION = 1;

export type WizardStep = 1 | 2 | 3;

export interface RetireDraft {
  version: number;
  savedAt: number;
  step: WizardStep;
  creditIds: string[];
  tonnes: string;
  reason: string;
  date: string;
}

/** Why a stored draft could not be restored. */
export type DiscardReason = 'expired' | 'invalid' | 'malformed' | null;

/** Wall-clock hook so tests can control time. */
let now = (): number => Date.now();

/** @internal test seam */
export function __setNow(fn: () => number): void {
  now = fn;
}

function isStep(v: unknown): v is WizardStep {
  return v === 1 || v === 2 || v === 3;
}

/** Shape guard for parsed JSON — rejects anything not matching RetireDraft. */
export function isRetireDraft(value: unknown): value is RetireDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<RetireDraft>;
  return (
    d.version === DRAFT_VERSION &&
    typeof d.savedAt === 'number' &&
    Number.isFinite(d.savedAt) &&
    isStep(d.step) &&
    Array.isArray(d.creditIds) &&
    d.creditIds.every((id) => typeof id === 'string' && id.length > 0) &&
    typeof d.tonnes === 'string' &&
    typeof d.reason === 'string' &&
    typeof d.date === 'string'
  );
}

/**
 * #959 — persists the retire wizard draft so a refresh or wallet disconnect
 * does not discard the user's selection work. Writes are best-effort: a
 * disabled/full localStorage must never break the wizard.
 */
@Injectable({ providedIn: 'root' })
export class RetireDraftStore {
  private readonly _draft = signal<RetireDraft | null>(null);
  private readonly _notice = signal<DiscardReason>(null);

  readonly draft = this._draft.asReadonly();
  readonly notice = this._notice.asReadonly();

  /** Serialises the current wizard state into storage. */
  save(input: {
    step: WizardStep;
    credits: CreditMetadata[];
    tonnes: string;
    reason: string;
  }): void {
    const draft: RetireDraft = {
      version: DRAFT_VERSION,
      savedAt: now(),
      step: input.step,
      creditIds: input.credits.map((c) => c.id),
      tonnes: input.tonnes,
      reason: input.reason,
      date: new Date(now()).toISOString(),
    };
    this._draft.set(draft);
    this._notice.set(null);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch {
      /* storage unavailable or full — draft stays in memory only */
    }
  }

  /**
   * Restores a stored draft, re-resolving credit ids against the caller's
   * current holdings. Returns the draft when valid, otherwise null with
   * `discardReason` set. Any failure clears the stored draft.
   */
  restore(available: CreditMetadata[]): RetireDraft | null {
    this._notice.set(null);

    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      this._notice.set('invalid');
      return null;
    }
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.clear('malformed');
      return null;
    }

    if (!isRetireDraft(parsed)) {
      this.clear('malformed');
      return null;
    }

    if (now() - parsed.savedAt > DRAFT_TTL_MS) {
      this.clear('expired');
      return null;
    }

    if (parsed.creditIds.length === 0) {
      this.clear('invalid');
      return null;
    }

    // Re-validate quantities against live holdings: a credit that is gone,
    // no longer Active, or holds a different quantity invalidates the draft.
    const byId = new Map(available.map((c) => [c.id, c]));
    const credits: CreditMetadata[] = [];
    for (const id of parsed.creditIds) {
      const credit = byId.get(id);
      if (!credit || credit.tonnes !== parsed.tonnes) {
        this.clear('invalid');
        return null;
      }
      credits.push(credit);
    }

    this._draft.set({ ...parsed, creditIds: parsed.creditIds });
    return { ...parsed };
  }

  /** Resolves restored ids back to live CreditMetadata records. */
  resolve(available: CreditMetadata[]): CreditMetadata[] {
    const draft = this._draft();
    if (!draft) return [];
    const byId = new Map(available.map((c) => [c.id, c]));
    return draft.creditIds.map((id) => byId.get(id)).filter((c): c is CreditMetadata => !!c);
  }

  /** Drops the stored draft and records why (for the user-facing notice). */
  clear(reason: DiscardReason = 'invalid'): void {
    this._draft.set(null);
    this._notice.set(reason);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clean up */
    }
  }

  /** User-initiated discard: silent, no notice. */
  discard(): void {
    this._draft.set(null);
    this._notice.set(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clean up */
    }
  }
}
