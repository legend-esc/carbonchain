import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { RetireComponent } from './retire.component';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ApiService } from '../core/services/api.service';
import { CreditStore } from '../core/store/credit.store';
import { signal } from '@angular/core';
import { of } from 'rxjs';

describe('RetireComponent', () => {
  let authServiceMock: Partial<AuthService>;
  let walletServiceMock: Partial<StellarWalletService>;
  let apiServiceMock: Partial<ApiService>;
  let creditStoreMock: Partial<CreditStore>;

  beforeEach(() => {
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
    };

    apiServiceMock = {
      retireCredit: () => of({ retirementId: 'abc123' }),
    };

    creditStoreMock = {
      loadOne: vi.fn().mockResolvedValue(undefined),
    };

    TestBed.configureTestingModule({
      imports: [RetireComponent],
      providers: [
        provideHttpClient(),
        provideRouter([]),
        { provide: AuthService, useValue: authServiceMock },
        { provide: StellarWalletService, useValue: walletServiceMock },
        { provide: ApiService, useValue: apiServiceMock },
        { provide: CreditStore, useValue: creditStoreMock },
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

  it('goConfirm() advances to confirm step', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    fixture.componentInstance.goConfirm();
    expect(fixture.componentInstance.step()).toBe('confirm');
  });

  it('reset() returns to form step and clears fields', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.creditId = 'abc';
    comp.reason = 'test';
    comp.goConfirm();
    comp.reset();
    expect(comp.step()).toBe('form');
    expect(comp.creditId).toBe('');
    expect(comp.reason).toBe('');
  });

  it('submit() calls retireCredit and sets success step', async () => {
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.creditId = '037176a1';
    comp.tonnes = 1_000_000;
    comp.reason = '2024 Scope 3';
    comp.goConfirm();
    await comp.submit();
    expect(comp.step()).toBe('success');
    expect(comp.retirementId()).toBe('abc123');
    expect(creditStoreMock.loadOne).toHaveBeenCalledWith('037176a1');
  });

  it('submit() sets error step on API failure', async () => {
    apiServiceMock.retireCredit = () => {
      throw new Error('Network error');
    };
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.creditId = '037176a1';
    comp.tonnes = 1_000_000;
    comp.reason = 'test';
    comp.goConfirm();
    await comp.submit();
    expect(comp.step()).toBe('error');
    expect(creditStoreMock.loadOne).not.toHaveBeenCalled();
  });

  it('formatTonnes converts units correctly', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    const result = fixture.componentInstance.formatTonnes(1_000_000);
    expect(result).toContain('1');
    expect(result).toContain('t');
  });
});
