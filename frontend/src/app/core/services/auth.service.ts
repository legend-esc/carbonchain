import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { StellarWalletService } from './stellar-wallet.service';
import { ApiService } from './api.service';

export type AuthState = 'unauthenticated' | 'authenticating' | 'authenticated' | 'error';

const SESSION_KEY = 'cc_jwt';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly wallet = inject(StellarWalletService);
  private readonly api = inject(ApiService);

  private readonly _token = signal<string | null>(
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SESSION_KEY) : null,
  );
  private readonly _authState = signal<AuthState>(
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem(SESSION_KEY)
      ? 'authenticated'
      : 'unauthenticated',
  );
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
   * Full SEP-10 handshake:
   * 1. Connect Freighter and obtain the wallet public key.
   * 2. Request a challenge transaction from POST /auth/challenge.
   * 3. Present the challenge XDR to Freighter for signing.
   * 4. Exchange the signed envelope for a JWT via POST /auth/verify.
   * 5. Persist the JWT in sessionStorage (not localStorage).
   */
  async connect(): Promise<void> {
    this._authState.set('authenticating');
    this._authError.set(null);

    try {
      // Step 1 — connect wallet and retrieve public key
      const publicKey = await this.wallet.connect();

      // Step 2 — request SEP-10 challenge
      const { transaction, network_passphrase } = await firstValueFrom(
        this.api.getChallenge(publicKey),
      );

      // Step 3 — sign challenge with Freighter
      const signedXdr = await this.wallet.signTransaction(transaction, network_passphrase);

      // Step 4 — exchange signed XDR for JWT
      const { access_token } = await firstValueFrom(this.api.getToken(signedXdr));

      // Step 5 — persist JWT in sessionStorage
      sessionStorage.setItem(SESSION_KEY, access_token);
      this._token.set(access_token);
      this._authState.set('authenticated');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed.';
      this._authError.set(msg);
      this._authState.set('error');
      throw err;
    }
  }

  /**
   * Alias for connect() — kept for backward compatibility with existing templates
   * that call `auth.login()`.
   */
  async login(): Promise<void> {
    return this.connect();
  }

  /** Clears session storage, resets all auth state, and disconnects the wallet. */
  disconnect(): void {
    sessionStorage.removeItem(SESSION_KEY);
    this._token.set(null);
    this._authState.set('unauthenticated');
    this._authError.set(null);
    this.wallet.disconnect();
  }

  /**
   * Alias for disconnect() — kept for backward compatibility with existing templates
   * that call `auth.logout()`.
   */
  logout(): void {
    this.disconnect();
  }

  /** Called by AuthInterceptor when a 401 is received mid-session. */
  clearSession(): void {
    sessionStorage.removeItem(SESSION_KEY);
    this._token.set(null);
    this._authState.set('unauthenticated');
    this._authError.set(null);
  }
}
