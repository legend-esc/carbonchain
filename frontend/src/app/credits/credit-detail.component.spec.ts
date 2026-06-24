import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { signal } from '@angular/core';
import { CreditDetailComponent } from './credit-detail.component';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { CreditStatus } from '@shared';

const MOCK_CREDIT = {
  id: 'abc123',
  project_id: 'proj_1',
  issuer: 'GABC',
  vintage_year: 2024,
  methodology: 'VCS',
  geography: 'NG',
  tonnes: '1000000',
  ipfs_hash: 'bafybei',
  status: CreditStatus.Active,
  issued_at: 1700000000,
};

const MOCK_PROVENANCE = [
  { event: 'submitted', actor: 'GABC', timestamp: 1700000001 },
  { event: 'approved', actor: 'GVER', timestamp: 1700000100, detail: 'VCS review passed' },
];

describe('CreditDetailComponent', () => {
  let fixture: ComponentFixture<CreditDetailComponent>;
  let component: CreditDetailComponent;
  let getCredit: ReturnType<typeof vi.fn>;
  let getCreditProvenance: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let publicKey: ReturnType<typeof signal<string | null>>;

  beforeEach(async () => {
    getCredit = vi.fn().mockReturnValue(of(MOCK_CREDIT));
    getCreditProvenance = vi.fn().mockReturnValue(of(MOCK_PROVENANCE));
    navigate = vi.fn();
    publicKey = signal<string | null>('GABC');

    await TestBed.configureTestingModule({
      imports: [CreditDetailComponent],
      providers: [
        { provide: ApiService, useValue: { getCredit, getCreditProvenance } },
        { provide: Router, useValue: { navigate } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'abc123' } } } },
        { provide: AuthService, useValue: { isAuthenticated: signal(true), token: signal('tok') } },
        { provide: StellarWalletService, useValue: { publicKey } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CreditDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('should load and display credit metadata', () => {
    expect(component.credit()).toEqual(MOCK_CREDIT);
    expect(component.loading()).toBe(false);
    expect(component.error()).toBeNull();
  });

  it('should load provenance events', () => {
    expect(getCreditProvenance).toHaveBeenCalledWith('abc123');
    expect(component.provenance()).toEqual(MOCK_PROVENANCE);
    expect(component.provenanceLoading()).toBe(false);
    expect(component.provenanceError()).toBeNull();
  });

  it('should set provenanceError on provenance API failure', async () => {
    getCreditProvenance.mockReturnValue(throwError(() => new Error('provenance unavailable')));
    component['provenance'].set([]);
    component['provenanceError'].set(null);
    await component['loadProvenance']('abc123');
    expect(component.provenanceError()).toBe('provenance unavailable');
  });

  it('should show retire and sell buttons for owner', () => {
    expect(component.isOwner()).toBe(true);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.btn-danger')).toBeTruthy();
    expect(el.querySelector('.btn-primary')).toBeTruthy();
  });

  it('should not show owner buttons when not owner', () => {
    publicKey.set('GOTHER');
    fixture.detectChanges();
    expect(component.isOwner()).toBe(false);
  });

  it('should set error on API failure', async () => {
    getCredit.mockReturnValue(throwError(() => new Error('not found')));
    component['loading'].set(true);
    component['error'].set(null);
    component['credit'].set(null);
    await component.ngOnInit();
    expect(component.error()).toBe('not found');
  });

  it('should navigate to /retire with creditId on retire()', () => {
    component.retire();
    expect(navigate).toHaveBeenCalledWith(['/retire'], { queryParams: { creditId: 'abc123' } });
  });

  it('should navigate to /marketplace with sell param on sell()', () => {
    component.sell();
    expect(navigate).toHaveBeenCalledWith(['/marketplace'], { queryParams: { sell: 'abc123' } });
  });

  it('formatTonnes should convert units correctly', () => {
    expect(component.formatTonnes('1000000')).toBe('1 t');
  });
});
