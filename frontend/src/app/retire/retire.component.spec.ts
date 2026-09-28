import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { RetireComponent, multipleOf100kValidator } from './retire.component';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ApiService } from '../core/services/api.service';
import { CreditStore } from '../core/store/credit.store';
import { ToastService } from '../core/services/toast.service';
import { CreditMetadata, CreditStatus } from '@shared';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { FormControl } from '@angular/forms';
import { WalletError, WALLET_ERROR_MESSAGES } from '../core/services/wallet-errors';

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
  let creditsSignal: ReturnType<typeof signal<CreditMetadata[]>>;

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
      networkMismatch: signal(false).asReadonly(),
      expectedNetwork: signal('testnet').asReadonly(),
      isFreighterInstalled: true,
      getNetworkDetails: vi.fn().mockResolvedValue({ networkPassphrase: 'Testnet' }),
      signTransaction: vi.fn().mockResolvedValue('AAAA-signed-xdr'),
    };

    apiServiceMock = {
      retireCredit: vi.fn().mockReturnValue(of({ retirementId: 'abc123' })),
    };

    creditsSignal = signal<CreditMetadata[]>([]);
    creditStoreMock = {
      credits: creditsSignal.asReadonly(),
      isLoading: signal(false).asReadonly(),
      loadOne: vi.fn().mockResolvedValue(undefined),
      loadByOwner: vi.fn().mockResolvedValue(undefined),
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
        { provide: ToastService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
        { provide: Router, useValue: routerMock },
      ],
    });
  });

  /** Build a component with one credit already selected. */
  function withSelection() {
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.selectedCredits.set([credit]);
    comp.reasonControl.setValue('2024 Scope 3');
    return comp;
  }

  it('creates the component', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('starts on step 1', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    expect(fixture.componentInstance.currentStep()).toBe(1);
  });

  it('goToStep(3) advances to the confirm step when the reason is valid', () => {
    const comp = withSelection();
    comp.goToStep(3);
    expect(comp.currentStep()).toBe(3);
  });

  it('goToStep(3) is blocked while the reason is empty', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.goToStep(3);
    expect(comp.currentStep()).toBe(1);
  });

  it('reset() returns to step 1 and clears fields', () => {
    const comp = withSelection();
    comp.goToStep(3);
    comp.reset();
    expect(comp.currentStep()).toBe(1);
    expect(comp.selectedCredits()).toEqual([]);
    expect(comp.reasonControl.value).toBe('');
    expect(comp.signingError()).toBeNull();
  });

  // ── Issue #965: holdings are loaded for the connected account, not a "project" ──

  it('ngOnInit loads credits via the owner endpoint for the connected address', async () => {
    const comp = withSelection();
    await comp.ngOnInit();
    expect(creditStoreMock.loadByOwner).toHaveBeenCalledWith('GABC123XYZ');
  });

  it('activeCredits never includes credits owned by another account', () => {
    const other: CreditMetadata = { ...credit, id: 'other-1', owner: 'GSOMEONEELSE' };
    creditsSignal.set([credit, other]);
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;

    expect(comp.activeCredits().map((c) => c.id)).toEqual([credit.id]);
  });

  it('submit() calls retireCredit and navigates to the certificate', async () => {
    const comp = withSelection();
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

  it('submit() with multiple credits calls batchRetire', async () => {
    const creditB: CreditMetadata = { ...credit, id: 'bbb222', tonnes: '2000000' };
    apiServiceMock.batchRetire = vi
      .fn()
      .mockReturnValue(of({ succeeded: ['abc123', 'bbb222'], failed: [] }));
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    comp.selectedCredits.set([credit, creditB]);
    comp.reasonControl.setValue('test');

    await comp.submit();

    expect(apiServiceMock.batchRetire).toHaveBeenCalledWith(
      {
        buyerPublicKey: 'GABC123XYZ',
        creditIds: [credit.id, 'bbb222'],
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

  // ── Issue #960: typed wallet errors ─────────────────────────────────────────

  it('maps a user rejection to the friendly "you cancelled" message, not a failure', async () => {
    apiServiceMock.retireCredit = vi
      .fn()
      .mockReturnValue(throwError(() => new Error('User rejected the request')));
    const comp = withSelection();

    await comp.submit();

    expect(comp.signingError()).toBe(WALLET_ERROR_MESSAGES.userRejected);
    expect(comp.currentStep()).toBe(3);
    // A cancellation is not a success either.
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('maps a transport failure to the network message', async () => {
    apiServiceMock.retireCredit = vi
      .fn()
      .mockReturnValue(throwError(() => new Error('net::ERR_BAD_RESPONSE')));
    const comp = withSelection();

    await comp.submit();

    expect(comp.signingError()).toBe(WALLET_ERROR_MESSAGES.network);
  });

  it('maps a timeout to the timeout message', async () => {
    apiServiceMock.retireCredit = vi
      .fn()
      .mockReturnValue(throwError(() => new Error('Wallet did not respond within 60s')));
    const comp = withSelection();

    await comp.submit();

    expect(comp.signingError()).toBe(WALLET_ERROR_MESSAGES.timeout);
  });

  it('rebuilds and re-submits once on a stale envelope, then succeeds', async () => {
    const retireCredit = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new WalletError('tx_bad_seq', 'staleEnvelope')))
      .mockReturnValueOnce(of({ retirementId: 'abc123' }));
    apiServiceMock.retireCredit = retireCredit;
    const comp = withSelection();

    await comp.submit();

    expect(retireCredit).toHaveBeenCalledTimes(2);
    expect(routerMock.navigate).toHaveBeenCalledWith(['/certificates', 'abc123']);
    expect(comp.signingError()).toBeNull();
  });

  it('gives up after one stale-envelope retry instead of looping', async () => {
    const retireCredit = vi
      .fn()
      .mockReturnValue(throwError(() => new WalletError('tx_bad_seq', 'staleEnvelope')));
    apiServiceMock.retireCredit = retireCredit;
    const comp = withSelection();

    await comp.submit();

    expect(retireCredit).toHaveBeenCalledTimes(2);
    expect(comp.signingError()).toBe(WALLET_ERROR_MESSAGES.staleEnvelope);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('does not retry a user rejection', async () => {
    const retireCredit = vi
      .fn()
      .mockReturnValue(throwError(() => new WalletError('User declined signing', 'userRejected')));
    apiServiceMock.retireCredit = retireCredit;
    const comp = withSelection();

    await comp.submit();

    expect(retireCredit).toHaveBeenCalledTimes(1);
  });

  // ── Issue #963: live-region announcements ──────────────────────────────────

  it('announces the current wizard step', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    const comp = fixture.componentInstance;
    expect(comp.stepAnnouncement()).toContain('Step 1 of 3');
    comp.currentStep.set(3);
    expect(comp.stepAnnouncement()).toContain('Step 3 of 3');
  });

  it('renders the step indicator and the live region', () => {
    const fixture = TestBed.createComponent(RetireComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[aria-live="polite"]')).toBeTruthy();
    expect(el.querySelector('[role="status"]')).toBeTruthy();
    expect(el.querySelector('table caption')).toBeTruthy();
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
