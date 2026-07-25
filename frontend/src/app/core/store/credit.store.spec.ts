import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CreditStore } from './credit.store';
import { ApiService } from '../services/api.service';
import { ToastService } from '../services/toast.service';
import { CreditStatus } from '@shared';

const ACTIVE_CREDIT = {
  id: 'credit-1',
  project_id: 'proj-1',
  issuer: 'GABC',
  vintage_year: 2024,
  methodology: 'VCS',
  geography: 'NG',
  tonnes: '1000000',
  ipfs_hash: 'bafybei',
  status: CreditStatus.Active,
  issued_at: 1700000000,
};

const RETIRED_CREDIT = { ...ACTIVE_CREDIT, status: CreditStatus.Retired };
const TRANSFERRED_CREDIT = { ...ACTIVE_CREDIT, issuer: 'GNEW' };

describe('CreditStore — cache invalidation', () => {
  let store: CreditStore;
  let getCredit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getCredit = vi.fn().mockReturnValue(of(ACTIVE_CREDIT));
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getCredit } },
        { provide: ToastService, useValue: { showError: vi.fn(), showSuccess: vi.fn() } },
      ],
    });
    store = TestBed.inject(CreditStore);
  });

  it('re-fetches credit via loadOne after retireCredit invalidates cache', async () => {
    // Seed the store with the active credit
    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));
    expect(store.credits()[0].status).toBe(CreditStatus.Active);

    // Simulate the cache being invalidated after retirement by returning the retired version
    getCredit.mockReturnValue(of(RETIRED_CREDIT));

    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));

    expect(getCredit).toHaveBeenCalledTimes(2);
    expect(store.credits()[0].status).toBe(CreditStatus.Retired);
  });

  it('re-fetches credit via loadOne after transferCredit invalidates cache', async () => {
    // Seed the store with the original owner
    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));
    expect(store.credits()[0].issuer).toBe('GABC');

    // Simulate cache invalidation after transfer — new owner reflected on re-fetch
    getCredit.mockReturnValue(of(TRANSFERRED_CREDIT));

    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));

    expect(getCredit).toHaveBeenCalledTimes(2);
    expect(store.credits()[0].issuer).toBe('GNEW');
  });

  it('loadOne merges updated credit in-place without duplicating', async () => {
    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));
    getCredit.mockReturnValue(of(RETIRED_CREDIT));
    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));

    expect(store.credits().length).toBe(1);
  });

  it('sets error state when re-fetch fails', async () => {
    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));
    getCredit.mockReturnValue(throwError(() => new Error('network error')));

    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));

    expect(store.loadingState()).toBe('error');
    expect(store.error()).toBe('network error');
  });
});

describe('CreditStore — optimistic splitCredit', () => {
  let store: CreditStore;
  let getCredit: ReturnType<typeof vi.fn>;
  let splitCredit: ReturnType<typeof vi.fn>;
  let showError: ReturnType<typeof vi.fn>;
  let showSuccess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getCredit = vi.fn().mockReturnValue(of(ACTIVE_CREDIT));
    splitCredit = vi.fn();
    showError = vi.fn();
    showSuccess = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getCredit, splitCredit } },
        { provide: ToastService, useValue: { showError, showSuccess } },
      ],
    });
    store = TestBed.inject(CreditStore);
  });

  it('optimistically adds children and retires parent on splitCredit', async () => {
    splitCredit.mockReturnValue(
      of({ childCredit1: 'real-child-1', childCredit2: 'real-child-2' }),
    );

    // Seed the store
    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));
    expect(store.credits().length).toBe(1);
    expect(store.credits()[0].status).toBe(CreditStatus.Active);

    // Perform split
    await TestBed.runInInjectionContext(() =>
      store.splitCredit('credit-1', '500000', 'test-token'),
    );

    // Should have 3 credits: retired parent + 2 children
    expect(store.credits().length).toBe(3);
    const parent = store.credits().find((c) => c.id === 'credit-1');
    expect(parent?.status).toBe(CreditStatus.Retired);

    const children = store.credits().filter((c) => c.id !== 'credit-1');
    expect(children.length).toBe(2);
    expect(children.every((c) => c.status === CreditStatus.Active)).toBe(true);
    expect(showSuccess).toHaveBeenCalledWith('Credit split successfully');
  });

  it('reconciles temporary IDs with real IDs on success', async () => {
    splitCredit.mockReturnValue(
      of({ childCredit1: 'real-child-1', childCredit2: 'real-child-2' }),
    );

    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));
    await TestBed.runInInjectionContext(() =>
      store.splitCredit('credit-1', '500000', 'test-token'),
    );

    // Real IDs should be present
    const childIds = store
      .credits()
      .filter((c) => c.id !== 'credit-1')
      .map((c) => c.id);
    expect(childIds).toContain('real-child-1');
    expect(childIds).toContain('real-child-2');
  });

  it('rolls back optimistic update on API failure', async () => {
    splitCredit.mockReturnValue(
      throwError(() => new Error('Internal Server Error')),
    );

    await TestBed.runInInjectionContext(() => store.loadOne('credit-1'));
    await TestBed.runInInjectionContext(() =>
      store.splitCredit('credit-1', '500000', 'test-token'),
    );

    // Should be back to original state: 1 active credit
    expect(store.credits().length).toBe(1);
    expect(store.credits()[0].id).toBe('credit-1');
    expect(store.credits()[0].status).toBe(CreditStatus.Active);
    expect(showError).toHaveBeenCalledWith('Internal Server Error');
  });

  it('shows error toast when credit not found', async () => {
    await TestBed.runInInjectionContext(() =>
      store.splitCredit('nonexistent', '500000', 'test-token'),
    );

    expect(showError).toHaveBeenCalledWith('Credit not found');
    expect(store.credits().length).toBe(0);
  });
});
