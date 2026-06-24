import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OfferDetailComponent } from './offer-detail.component';
import { Offer } from '@shared';
import { ComponentRef } from '@angular/core';

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

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OfferDetailComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(OfferDetailComponent);
    ref = fixture.componentRef;
    ref.setInput('offer', mockOffer);
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
      '[aria-label="Close"]',
    ) as HTMLButtonElement;
    closeBtn.click();

    expect(emitted).toBe(true);
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
    expect(component.formatXlm('50000000')).toBe('5 XLM');
  });
});
