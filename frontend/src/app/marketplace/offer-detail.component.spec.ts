import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { OfferDetailComponent } from './offer-detail.component';
import { Offer } from '@shared';
import { ComponentRef } from '@angular/core';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { AuthService } from '../core/services/auth.service';
import { ApiService } from '../core/services/api.service';

const mockOffer: Offer = {
  id: '42',
  seller: 'GSELLER1234567890',
  credit_id: 'deadbeef1234',
  price_xlm: '50000000',
  tonnes_available: '5000000',
  created_at: 1700000000,
  status: 'open',
};

describe('OfferDetailComponent', () => {
  let fixture: ComponentFixture<OfferDetailComponent>;
  let component: OfferDetailComponent;
  let ref: ComponentRef<OfferDetailComponent>;

  const walletMock = {
    publicKey: signal('GPUBKEY1234567890'),
    signTransaction: vi.fn().mockResolvedValue('signed-xdr'),
  };

  const authMock = {
    token: signal('mock-token'),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OfferDetailComponent],
      providers: [
        provideRouter([]),
        { provide: StellarWalletService, useValue: walletMock },
        { provide: AuthService, useValue: authMock },
        {
          provide: ApiService,
          useValue: {
            getBuyOfferXdr: vi.fn().mockReturnValue(of({ xdr: 'fake-xdr' })),
            buyOffer: vi.fn().mockReturnValue(of(undefined)),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(OfferDetailComponent);
    ref = fixture.componentRef;
    ref.setInput('offer', mockOffer);
    ref.setInput('errorCode', null);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('displays offer id', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('42');
  });

  it('displays credit id', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('deadbeef1234');
  });

  it('emits closed when close button clicked', () => {
    let emitted = false;
    component.closed.subscribe(() => (emitted = true));

    const closeBtn = fixture.nativeElement.querySelector(
      '[aria-label="Close offer details"]',
    ) as HTMLButtonElement;
    closeBtn.click();

    expect(emitted).toBe(true);
  });

  it('shows expired offer message when errorCode=309', () => {
    ref.setInput('errorCode', 309);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('This offer has expired');
    expect(text).toContain('Back to marketplace');
  });

  it('emits buy with offer when buy button clicked', () => {
    let emitted: Offer | undefined;
    component.buy.subscribe((o: Offer) => (emitted = o));

    const buyBtn = fixture.nativeElement.querySelector('.btn-primary') as HTMLButtonElement;
    buyBtn.click();

    expect(emitted).toEqual(mockOffer);
  });

  it('formats tonnes correctly', () => {
    expect(component.formatTonnes('5000000')).toBe('5 t');
  });

  it('formats XLM correctly', () => {
    expect(component.formatTonnes('50000000')).toBe('50 t');
  });
});
