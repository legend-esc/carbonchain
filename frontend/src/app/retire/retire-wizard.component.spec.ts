import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { RetireWizardComponent } from './retire-wizard.component';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ApiService } from '../core/services/api.service';
import { CreditStore } from '../core/store/credit.store';
import { ToastService } from '../core/services/toast.service';
import { CreditMetadata, CreditStatus } from '@shared';

const makeCredit = (overrides: Partial<CreditMetadata> = {}): CreditMetadata => ({
  id: 'c1',
  project_id: 'p1',
  issuer: 'GISSUER',
  owner: 'GPUBKEY',
  vintage_year: 2023,
  methodology: 'VCS',
  geography: 'BR',
  tonnes: '2000000',
  ipfs_hash: 'ipfs://x',
  status: CreditStatus.Active,
  issued_at: 1700000000,
  ...overrides,
});

describe('RetireWizardComponent', () => {
  let fixture: ComponentFixture<RetireWizardComponent>;
  let component: RetireWizardComponent;

  const authMock = {
    isAuthenticated: signal(true).asReadonly(),
    token: signal('jwt-tok').asReadonly(),
    authState: signal('authenticated' as const).asReadonly(),
    authError: signal<string | null>(null).asReadonly(),
    logout: vi.fn(),
  };

  const walletMock = {
    publicKey: signal<string | null>('GPUBKEY').asReadonly(),
    isConnected: signal(true).asReadonly(),
    state: signal('connected' as const).asReadonly(),
    networkMismatch: signal(false).asReadonly(),
    expectedNetwork: signal('testnet').asReadonly(),
    isFreighterInstalled: true,
    xlmBalance: signal<number | null>(100).asReadonly(),
  };

  let creditsSignal = signal<CreditMetadata[]>([]);
  const storeMock = {
    get credits() {
      return creditsSignal.asReadonly();
    },
    activeCredits: signal<CreditMetadata[]>([]).asReadonly(),
    retiredCredits: signal<CreditMetadata[]>([]).asReadonly(),
    isLoading: signal(false).asReadonly(),
    loadByOwner: vi.fn().mockResolvedValue(undefined),
    loadOne: vi.fn().mockResolvedValue(undefined),
  };

  const apiMock = {
    retireCredit: vi.fn().mockReturnValue(of({ retirementId: 'ret-001' })),
    batchRetire: vi.fn().mockReturnValue(of({ succeeded: ['ret-001'], failed: [] })),
    downloadCertificate: vi.fn().mockReturnValue(of(new Blob(['pdf']))),
  };

  const toastMock = {
    show: vi.fn(),
    showSuccess: vi.fn(),
    showError: vi.fn(),
    showInfo: vi.fn(),
  };

  beforeEach(async () => {
    creditsSignal = signal<CreditMetadata[]>([]);

    await TestBed.configureTestingModule({
      imports: [RetireWizardComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authMock },
        { provide: StellarWalletService, useValue: walletMock },
        { provide: ApiService, useValue: apiMock },
        { provide: CreditStore, useValue: storeMock },
        { provide: ToastService, useValue: toastMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RetireWizardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders step 1 by default', () => {
    expect(component.currentStep()).toBe(1);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[aria-labelledby="step1-title"]')).toBeTruthy();
  });

  it('shows all 4 step indicators', () => {
    const el: HTMLElement = fixture.nativeElement;
    const indicators = el.querySelectorAll('.step-indicator');
    expect(indicators.length).toBe(4);
  });

  it('disables Next button on step 1 when no credits selected', () => {
    const btn = fixture.nativeElement.querySelector(
      '.step-panel .btn-primary',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('enables Next button when a credit is selected', () => {
    creditsSignal.set([makeCredit()]);
    fixture.detectChanges();
    component.toggleCredit(makeCredit());
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      '.step-panel .btn-primary',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('advances to step 2 from step 1', () => {
    component.selectedCredits.set([makeCredit()]);
    component.goToStep(2);
    fixture.detectChanges();
    expect(component.currentStep()).toBe(2);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[aria-labelledby="step2-title"]')).toBeTruthy();
  });

  it('blocks step 2 → step 3 when beneficiary is empty', () => {
    component.selectedCredits.set([makeCredit()]);
    component.goToStep(2);
    fixture.detectChanges();
    component.beneficiary = '';
    component.reasonControl.setValue('some reason');
    component.submitStep2();
    fixture.detectChanges();
    expect(component.currentStep()).toBe(2);
  });

  it('blocks step 2 → step 3 when reason is empty', () => {
    component.selectedCredits.set([makeCredit()]);
    component.goToStep(2);
    component.beneficiary = 'Acme Corp';
    component.reasonControl.setValue('');
    component.submitStep2();
    expect(component.currentStep()).toBe(2);
  });

  it('advances to step 3 when both beneficiary and reason are set', () => {
    component.selectedCredits.set([makeCredit()]);
    component.goToStep(2);
    component.beneficiary = 'Acme Corp';
    component.reasonControl.setValue('Net zero commitment');
    component.submitStep2();
    expect(component.currentStep()).toBe(3);
  });

  it('shows fee breakdown on step 3', () => {
    component.selectedCredits.set([makeCredit()]);
    component.beneficiary = 'Acme Corp';
    component.reasonControl.setValue('Net zero commitment');
    component.goToStep(3);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.fee-breakdown')).toBeTruthy();
    expect(el.querySelector('.fee-table')).toBeTruthy();
  });

  it('computes platform fee as 1.5% of credit cost', () => {
    component.selectedCredits.set([makeCredit({ tonnes: '2000000' })]);
    // 2 tonnes * 10 XLM = 20 XLM credit cost → 1.5% = 0.3
    expect(component.platformFee()).toBeCloseTo(0.3, 4);
  });

  it('calls retireCredit API on step 3 submit', async () => {
    component.selectedCredits.set([makeCredit()]);
    component.beneficiary = 'Acme Corp';
    component.reasonControl.setValue('reason');
    component.goToStep(3);
    await component.submitRetirement();
    expect(apiMock.retireCredit).toHaveBeenCalled();
  });

  it('advances to step 4 (celebrate) after successful submission', async () => {
    component.selectedCredits.set([makeCredit()]);
    component.beneficiary = 'Acme Corp';
    component.reasonControl.setValue('reason');
    component.goToStep(3);
    await component.submitRetirement();
    expect(component.currentStep()).toBe(4);
  });

  it('renders confetti and certificate link on step 4', async () => {
    component.selectedCredits.set([makeCredit()]);
    component.beneficiary = 'Acme Corp';
    component.reasonControl.setValue('reason');
    component.goToStep(3);
    await component.submitRetirement();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.confetti-wrap')).toBeTruthy();
    expect(el.querySelector('.cert-actions')).toBeTruthy();
  });

  it('back button on step 2 returns to step 1', () => {
    component.selectedCredits.set([makeCredit()]);
    component.goToStep(2);
    fixture.detectChanges();
    const back = fixture.nativeElement.querySelector('.btn-outline') as HTMLButtonElement;
    back.click();
    fixture.detectChanges();
    expect(component.currentStep()).toBe(1);
  });

  it('computes step announcement correctly', () => {
    expect(component.stepAnnouncement()).toContain('Step 1');
    component.goToStep(3);
    expect(component.stepAnnouncement()).toContain('Step 3');
  });
});
