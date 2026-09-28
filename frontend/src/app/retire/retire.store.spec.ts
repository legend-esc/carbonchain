import { TestBed } from '@angular/core/testing';
import { CreditMetadata, CreditStatus } from '@shared';
import { DRAFT_TTL_MS, RetireDraftStore, isRetireDraft } from './retire.store';

const KEY = 'retire.draft.v1';

function credit(id: string, tonnes = '1000000'): CreditMetadata {
  return {
    id,
    project_id: 'P1',
    issuer: 'issuer-addr',
    owner: 'GABC123XYZ',
    vintage_year: 2024,
    methodology: 'm',
    geography: 'g',
    tonnes,
    ipfs_hash: 'ipfs://x',
    status: CreditStatus.Active,
    issued_at: 1710000000,
  };
}

describe('RetireDraftStore (#959)', () => {
  let store: RetireDraftStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    store = TestBed.inject(RetireDraftStore);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('persists credits, tonnes, reason and step to localStorage', () => {
    store.save({ step: 2, credits: [credit('a1')], tonnes: '1000000', reason: 'scope 3' });

    const raw = localStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.creditIds).toEqual(['a1']);
    expect(parsed.tonnes).toBe('1000000');
    expect(parsed.reason).toBe('scope 3');
    expect(parsed.step).toBe(2);
    expect(typeof parsed.date).toBe('string');
  });

  it('restores a valid draft and resolves credits against live holdings', () => {
    store.save({ step: 2, credits: [credit('a1')], tonnes: '1000000', reason: 'scope 3' });

    const fresh = TestBed.inject(RetireDraftStore);
    const restored = fresh.restore([credit('a1')]);

    expect(restored).not.toBeNull();
    expect(restored!.reason).toBe('scope 3');
    expect(fresh.resolve([credit('a1')]).map((c) => c.id)).toEqual(['a1']);
  });

  it('clears an expired draft and reports the reason', () => {
    store.save({ step: 1, credits: [credit('a1')], tonnes: '1000000', reason: 'r' });
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    stored.savedAt = Date.now() - DRAFT_TTL_MS - 1000;
    localStorage.setItem(KEY, JSON.stringify(stored));

    const fresh = TestBed.inject(RetireDraftStore);
    const restored = fresh.restore([credit('a1')]);

    expect(restored).toBeNull();
    expect(fresh.notice()).toBe('expired');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('invalidates the draft when a selected credit is no longer held', () => {
    store.save({ step: 1, credits: [credit('a1'), credit('b2')], tonnes: '1000000', reason: 'r' });

    const fresh = TestBed.inject(RetireDraftStore);
    const restored = fresh.restore([credit('a1')]);

    expect(restored).toBeNull();
    expect(fresh.notice()).toBe('invalid');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('invalidates the draft when the stored quantity no longer matches', () => {
    store.save({ step: 1, credits: [credit('a1')], tonnes: '1000000', reason: 'r' });

    const fresh = TestBed.inject(RetireDraftStore);
    const restored = fresh.restore([credit('a1', '2000000')]);

    expect(restored).toBeNull();
    expect(fresh.notice()).toBe('invalid');
  });

  it('clears a malformed draft without throwing', () => {
    localStorage.setItem(KEY, '{not json');

    const fresh = TestBed.inject(RetireDraftStore);
    expect(fresh.restore([credit('a1')])).toBeNull();
    expect(fresh.notice()).toBe('malformed');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('discard() removes the draft and leaves no notice', () => {
    store.save({ step: 1, credits: [credit('a1')], tonnes: '1000000', reason: 'r' });
    store.discard();

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(store.notice()).toBeNull();
    expect(store.resolve([credit('a1')])).toEqual([]);
  });

  it('restore() returns null with no notice when nothing is stored', () => {
    const restored = store.restore([credit('a1')]);
    expect(restored).toBeNull();
    expect(store.notice()).toBeNull();
  });
});

describe('isRetireDraft (#959)', () => {
  const valid = {
    version: 1,
    savedAt: Date.now(),
    step: 1,
    creditIds: ['a1'],
    tonnes: '1000000',
    reason: 'r',
    date: '2024-01-01T00:00:00.000Z',
  };

  it('accepts a well-formed draft', () => {
    expect(isRetireDraft(valid)).toBe(true);
  });

  it('rejects non-objects, bad steps, and bad field types', () => {
    expect(isRetireDraft(null)).toBe(false);
    expect(isRetireDraft('x')).toBe(false);
    expect(isRetireDraft({ ...valid, version: 2 })).toBe(false);
    expect(isRetireDraft({ ...valid, step: 4 })).toBe(false);
    expect(isRetireDraft({ ...valid, creditIds: 'a1' })).toBe(false);
    expect(isRetireDraft({ ...valid, reason: 42 })).toBe(false);
  });
});
