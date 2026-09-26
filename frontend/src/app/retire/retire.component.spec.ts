import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { RetireComponent, multipleOf100kValidator } from './retire.component';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ApiService } from '../core/services/api.service';
import { CreditStore } from '../core/store/credit.store';
import { CreditMetadata, CreditStatus } from '@shared';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { FormControl } from '@angular/forms';

const credit: CreditMetadata = {
  id: '037176a1',
  project_id: 'P1',
  issuer: 'issuer-addr',
  owner: 'GABC123XYZ',
  vintage_year: 2024,
  methodology: 'm',
  geography: 'g',
  tonnes: '1000000',
  ipfs_hash: 'ipfs://x',
  status: CreditStatus.Active,
  issued_at: 1710000000,
};

describe('RetireComponent', () => {
  let authServiceMock: Partial<AuthService>;
  let walletServiceMock: Partial<StellarWalletService>;
  let apiServiceMock: Partial<ApiService>;
  let creditStoreMock: Partial<CreditStore>;
  let routerMock: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    TestBed.resetTestingModule();

    authServiceMock = {
      isAuthenticated: signal(true).asReadonly(),
      token: signal('mock-token').asReadonly(),
      authState: signal('authenticated' as const).asReadonly(),
      authError: signal(null).asReadonly(),
    };

    walletServiceMock = {
      publicKey: signal('GABC123XYZ').asReadonly(),
      state: signal('connected' as const).asReadonly(),
      isConnected: signal(true).asReadonly(),
      isFreighterInstalled: true,
      getNetworkDetails: vi.fn().mockResolvedValue({ networkPassphrase: 'Testnet' }),
      signTransaction: vi.fn().mockResolvedValue('AAAA-signed-xdr'),
    };

    apiServiceMock = {
      retireCredit: vi.fn().mockReturnValue(of({ retirementId: 'abc123' })),
    };

    creditStoreMock = {
      credits: signal([]).asReadonly(),
      isLoading: signal(false).asReadonly(),
      loadOne: vi.fn().mockResolvedValue(undefined),
      loadByProject: vi.fn().mockResolvedValue(undefined),
    };

    routerMock = { navigate: vi.fn().mockResolvedValue(true) };

    TestBed.configureTestingModule({
      imports: [RetireComponent],
      providers: [
        provideHttpClient(),
        { provide: AuthService, useValue: authServiceMock },
        { provide: StellarWalletService, useValue: walletServiceMock },
        { provide: ApiService, useValue: apiServiceMock },
        { provide: CreditStore, useValue: creditStoreMock },
        { provide: Router, useValue: routerMock },
      ],
    });
  });

  it('creates the component', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('starts on the form step', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    expect(fixture.componentInstance.step()).toBe('form');
  });

  it('step.set(confirm) advances to the confirm step', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.step.set('confirm');
    expect(comp.step()).toBe('confirm');
  });

  it('reset() returns to form step and clears fields', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.selectedCredits.set([credit]);
    comp.reason = 'test';
    comp.step.set('confirm');
    comp.reset();
    expect(comp.step()).toBe('form');
    expect(comp.selectedCredits()).toEqual([]);
    expect(comp.reason).toBe('');
  });

  it('submit() calls retireCredit and navigates to the certificate', async () => {
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.selectedCredits.set([credit]);
    comp.reason = '2024 Scope 3';

    await comp.submit();

    expect(apiServiceMock.retireCredit).toHaveBeenCalledWith(
      {
        buyerPublicKey: 'GABC123XYZ',
        creditId: credit.id,
        tonnes: credit.tonnes,
        reason: '2024 Scope 3',
      },
      'mock-token',
    );
    expect(creditStoreMock.loadOne).toHaveBeenCalledWith(credit.id);
    expect(routerMock.navigate).toHaveBeenCalledWith(['/certificates', 'abc123']);
  });

  it('submit() sets signingError on API failure (replaces old wallet-rejection path)', async () => {
    apiServiceMock.retireCredit = vi
      .fn()
      .mockReturnValue(throwError(() => new Error('User rejected')));
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.selectedCredits.set([credit]);
    comp.reason = 'test';

    await comp.submit();

    expect(comp.errorMsg()).toBe('User rejected');
    expect(comp.step()).toBe('confirm');
  });

  it('submit() sets signingError on API failure', async () => {
    apiServiceMock.retireCredit = vi
      .fn()
      .mockReturnValue(throwError(() => new Error('Network error')));
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.selectedCredits.set([credit]);
    comp.reason = 'test';

    await comp.submit();

    expect(comp.errorMsg()).toBe('Network error');
    expect(comp.step()).toBe('confirm');
  });

  it('submit() with multiple credits calls batchRetire', async () => {
    const creditB: CreditMetadata = { ...credit, id: 'bbb222', tonnes: '2000000' };
    apiServiceMock.batchRetire = vi
      .fn()
      .mockReturnValue(of({ succeeded: ['abc123', 'bbb222'], failed: [] }));
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.selectedCredits.set([credit, creditB]);
    comp.reason = 'test';

    await comp.submit();

    expect(apiServiceMock.batchRetire).toHaveBeenCalledWith(
      {
        buyerPublicKey: 'GABC123XYZ',
        creditIds: [credit.id, creditB.id],
        tonnes: [credit.tonnes, creditB.tonnes],
        reason: 'test',
      },
      'mock-token',
    );
    expect(routerMock.navigate).toHaveBeenCalledWith(['/certificates', 'abc123']);
  });

  it('formatTonnes converts units correctly', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    const result = fixture.componentInstance.formatTonnes('1000000');
    expect(result).toContain('1');
    expect(result).toContain('t');
  });
});

// ── multipleOf100kValidator ───────────────────────────────────────────────────

describe('multipleOf100kValidator', () => {
  const validate = multipleOf100kValidator();

  it('returns error for non-multiple (150001)', () => {
    const ctrl = new FormControl(150_001);
    expect(validate(ctrl)).toEqual({ multipleOf100k: true });
  });

  it('returns null for valid multiple (100000)', () => {
    const ctrl = new FormControl(100_000);
    expect(validate(ctrl)).toBeNull();
  });

  it('returns null for 1_000_000', () => {
    const ctrl = new FormControl(1_000_000);
    expect(validate(ctrl)).toBeNull();
  });

  it('returns error for zero', () => {
    const ctrl = new FormControl(0);
    expect(validate(ctrl)).toEqual({ multipleOf100k: true });
  });

  it('returns error for negative', () => {
    const ctrl = new FormControl(-100_000);
    expect(validate(ctrl)).toEqual({ multipleOf100k: true });
  });
});
