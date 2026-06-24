import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ConnectWalletComponent } from './connect-wallet.component';
import { StellarWalletService } from '../services/stellar-wallet.service';
import { AuthService } from '../services/auth.service';
import { signal } from '@angular/core';

function createMocks(freighterInstalled: boolean) {
  const walletStub = {
    isFreighterInstalled: freighterInstalled,
    publicKey: signal<string | null>(null),
    isConnected: signal(false),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as StellarWalletService;

  const authStub = {
    isAuthenticated: signal(false),
    authState: signal('unauthenticated' as const),
    authError: signal<string | null>(null),
    login: vi.fn(),
    logout: vi.fn(),
  } as unknown as AuthService;

  return { walletStub, authStub };
}

describe('ConnectWalletComponent', () => {
  let fixture: ComponentFixture<ConnectWalletComponent>;

  describe('when Freighter is NOT installed', () => {
    beforeEach(async () => {
      const { walletStub, authStub } = createMocks(false);

      await TestBed.configureTestingModule({
        imports: [ConnectWalletComponent],
        providers: [
          { provide: StellarWalletService, useValue: walletStub },
          { provide: AuthService, useValue: authStub },
        ],
      }).compileComponents();

      fixture = TestBed.createComponent(ConnectWalletComponent);
      fixture.detectChanges();
    });

    it('shows a download link to freighter.app instead of the connect button', () => {
      const el: HTMLElement = fixture.nativeElement;
      const link = el.querySelector<HTMLAnchorElement>('a[href="https://freighter.app"]');
      expect(link).not.toBeNull();
      expect(link!.textContent).toContain('Install Freighter');
    });

    it('does not render a connect button', () => {
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelectorAll('button').length).toBe(0);
    });
  });

  describe('when Freighter IS installed', () => {
    beforeEach(async () => {
      const { walletStub, authStub } = createMocks(true);

      await TestBed.configureTestingModule({
        imports: [ConnectWalletComponent],
        providers: [
          { provide: StellarWalletService, useValue: walletStub },
          { provide: AuthService, useValue: authStub },
        ],
      }).compileComponents();

      fixture = TestBed.createComponent(ConnectWalletComponent);
      fixture.detectChanges();
    });

    it('shows the Connect Wallet button', () => {
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector('button');
      expect(btn).not.toBeNull();
      expect(btn!.textContent).toContain('Connect Wallet');
    });

    it('does not show the Install Freighter link', () => {
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('a[href="https://freighter.app"]')).toBeNull();
    });
  });
});
