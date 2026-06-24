import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { DashboardComponent } from './dashboard.component';
import { CreditStore } from '../core/store/credit.store';

describe('DashboardComponent', () => {
  let store: CreditStore;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [provideHttpClient()],
    }).compileComponents();
    store = TestBed.inject(CreditStore);
  });

  it('shows skeleton loaders while loading', () => {
    // Simulate loading state before fixture is created
    (store as any)['_loadingState'].set('loading');

    const fixture = TestBed.createComponent(DashboardComponent);
    // Simulate connected wallet so the loading branch is reachable
    const wallet = (fixture.componentInstance as any).wallet;
    spyOn(wallet, 'isConnected').and.returnValue(true);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.skeleton-grid')).toBeTruthy();
    expect(el.querySelector('.skeleton--stat')).toBeTruthy();
    expect(el.querySelector('.skeleton--row')).toBeTruthy();
    // Loading text should not appear
    expect(el.textContent).not.toContain('Loading credits…');
  });

  it('hides skeleton loaders when not loading', () => {
    (store as any)['_loadingState'].set('idle');

    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.skeleton-grid')).toBeFalsy();
  });
});
