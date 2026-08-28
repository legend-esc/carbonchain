import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { NetworkIndicatorComponent } from './network-indicator.component';
import { StellarWalletService } from '../services/stellar-wallet.service';

function createWalletStub(network: 'testnet' | 'mainnet' | null, mismatch: boolean) {
  return {
    network: signal(network),
    networkMismatch: signal(mismatch),
    checkNetworkMatch: vi.fn().mockResolvedValue(true),
  } as unknown as StellarWalletService;
}

describe('NetworkIndicatorComponent', () => {
  let fixture: ComponentFixture<NetworkIndicatorComponent>;

  async function setup(walletStub: StellarWalletService) {
    await TestBed.configureTestingModule({
      imports: [NetworkIndicatorComponent],
      providers: [{ provide: StellarWalletService, useValue: walletStub }],
    }).compileComponents();

    fixture = TestBed.createComponent(NetworkIndicatorComponent);
    fixture.detectChanges();
  }

  it('renders no badge when no network is known', async () => {
    await setup(createWalletStub(null, false));
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.network-badge')).toBeNull();
  });

  it('renders a Testnet badge', async () => {
    await setup(createWalletStub('testnet', false));
    const el: HTMLElement = fixture.nativeElement;
    const badge = el.querySelector('.network-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('Testnet');
    expect(badge!.classList.contains('testnet')).toBe(true);
  });

  it('renders a Mainnet badge', async () => {
    await setup(createWalletStub('mainnet', false));
    const el: HTMLElement = fixture.nativeElement;
    const badge = el.querySelector('.network-badge');
    expect(badge!.textContent).toContain('Mainnet');
    expect(badge!.classList.contains('mainnet')).toBe(true);
  });

  it('does not show the mismatch modal when networks agree', async () => {
    await setup(createWalletStub('testnet', false));
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.network-modal-backdrop')).toBeNull();
  });

  it('shows a warning modal telling the user which network to switch to', async () => {
    await setup(createWalletStub('testnet', true));
    const el: HTMLElement = fixture.nativeElement;
    const modal = el.querySelector('.network-modal-backdrop');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('Please switch to Testnet in Freighter');
  });
});
