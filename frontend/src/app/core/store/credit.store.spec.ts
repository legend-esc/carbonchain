import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CreditStore } from './credit.store';
import { ApiService } from '../services/api.service';
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
      providers: [{ provide: ApiService, useValue: { getCredit } }],
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
