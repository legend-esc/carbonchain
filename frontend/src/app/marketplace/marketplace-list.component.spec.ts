import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { MarketplaceListComponent } from './marketplace-list.component';
import { ApiService } from '../core/services/api.service';
import { Offer } from '@shared';

const mockOffer: Offer = {
  id: '1',
  seller: 'GTEST1234567890',
  credit_id: 'abc123def456',
  price_xlm: '10000000',
  tonnes_available: '2000000',
  created_at: 1700000000,
  status: 'open',
};

describe('MarketplaceListComponent', () => {
  let fixture: ComponentFixture<MarketplaceListComponent>;
  let component: MarketplaceListComponent;
  let apiSpy: ReturnType<typeof createApiSpy>;

  function createApiSpy() {
    return { getListings: vi.fn().mockReturnValue(of([])) };
  }

  beforeEach(async () => {
    apiSpy = createApiSpy();

    await TestBed.configureTestingModule({
      imports: [MarketplaceListComponent],
      providers: [{ provide: ApiService, useValue: apiSpy }],
    }).compileComponents();

    fixture = TestBed.createComponent(MarketplaceListComponent);
    component = fixture.componentInstance;
  });

  it('shows "No active listings" when empty', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No active listings');
  });

  it('renders offers in a table', async () => {
    apiSpy.getListings.mockReturnValue(of([mockOffer]));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr') as NodeList;
    expect(rows.length).toBe(1);
  });

  it('shows error message on API failure', async () => {
    apiSpy.getListings.mockReturnValue(throwError(() => new Error('Network error')));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Network error');
  });

  it('emits offerSelected when a row is clicked', async () => {
    apiSpy.getListings.mockReturnValue(of([mockOffer]));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    let emitted: Offer | undefined;
    component.offerSelected.subscribe((o: Offer) => (emitted = o));

    const row = fixture.nativeElement.querySelector('tbody tr') as HTMLElement;
    row.click();

    expect(emitted).toEqual(mockOffer);
  });

  it('formats tonnes correctly', () => {
    expect(component.formatTonnes('2000000')).toBe('2 t');
  });

  it('formats XLM correctly', () => {
    expect(component.formatXlm('10000000')).toBe('1 XLM');
  });
});
