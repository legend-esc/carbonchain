import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { StellarWalletService } from './stellar-wallet.service';
import { ApiService } from './api.service';

export type AuthState = 'unauthenticated' | 'authenticating' | 'authenticated' | 'error';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly wallet = inject(StellarWalletService);
  private readonly api = inject(ApiService);

  private readonly _token = signal<string | null>(null);
  private readonly _authState = signal<AuthState>('unauthenticated');
  private readonly _authError = signal<string | null>(null);

  readonly token = this._token.asReadonly();
  readonly authState = this._authState.asReadonly();
  readonly authError = this._authError.asReadonly();
  readonly isAuthenticated = computed(() => this._authState() === 'authenticated');
  readonly isAdmin = computed(() => {
    const t = this._token();
    if (!t) return false;
    try {
      const payload = JSON.parse(atob(t.split('.')[1]));
      return payload.role === 'admin';
    } catch {
      return false;
    }
  });

  /**
   * Full SEP-10 flow:
   * 1. Connect Freighter and get public key
   * 2. Fetch challenge transaction from API
   * 3. Sign it with Freighter
   * 4. Exchange signed XDR for a JWT
   */
  async login(): Promise<void> {
    this._authState.set('authenticating');
    this._authError.set(null);

    try {
      // Step 1 — connect wallet
      const publicKey = await this.wallet.connect();

      // Step 2 — get challenge
      const { transaction, network_passphrase } = await firstValueFrom(
        this.api.getChallenge(publicKey),
      );

      // Step 3 — sign with Freighter
      const signedXdr = await this.wallet.signTransaction(transaction, network_passphrase);

      // Step 4 — exchange for JWT
      const { access_token } = await firstValueFrom(this.api.getToken(signedXdr));

      this._token.set(access_token);
      this._authState.set('authenticated');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed.';
      this._authError.set(msg);
      this._authState.set('error');
      throw err;
    }
  }

  logout(): void {
    this._token.set(null);
    this._authState.set('unauthenticated');
    this._authError.set(null);
    this.wallet.disconnect();
  }

  /** Called by AuthInterceptor when a 401 is received mid-session. */
  clearSession(): void {
    this._token.set(null);
    this._authState.set('unauthenticated');
    this._authError.set(null);
  }
}
