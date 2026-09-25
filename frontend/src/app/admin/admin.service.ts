import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface ExpireCreditResult {
  creditId: string;
  expired: boolean;
  txHash: string;
}

export interface ResolveDisputeResult {
  disputeId: string;
  resolved: boolean;
  resolution: string;
  txHash: string;
}

export interface SlashVerifierResult {
  verifierAddress: string;
  slashed: boolean;
  amount: string;
  unbondingPeriodDays: number;
  txHash: string;
}

/**
 * AdminService encapsulates admin-only on-chain actions:
 * - expireCredit:   Force-expire a credit (e.g. after MRV failure).
 * - resolveDispute: Close an open dispute with a resolution outcome.
 * - slashVerifier:  Slash a misbehaving verifier's stake with unbonding notice.
 *
 * Each method follows a build → sign → submit pattern: the API backend
 * constructs and submits the Soroban transaction; the frontend only provides
 * the inputs and JWT.
 */
@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api/admin';

  // ── Expire Credit ──────────────────────────────────────────────────────────

  /**
   * POST /api/admin/credits/:id/expire
   * Force-expires a credit, preventing further use.
   *
   * @param creditId  Hex credit ID.
   * @param reason    Human-readable reason for expiry (stored on-chain).
   * @param token     Admin JWT.
   */
  expireCredit(
    creditId: string,
    reason: string,
    token: string,
  ): Observable<ExpireCreditResult> {
    return this.http.post<ExpireCreditResult>(
      `${this.baseUrl}/credits/${creditId}/expire`,
      { reason },
      { headers: this.authHeaders(token) },
    );
  }

  // ── Resolve Dispute ────────────────────────────────────────────────────────

  /**
   * POST /api/admin/disputes/:id/resolve
   * Closes an open dispute with a resolution outcome.
   *
   * @param disputeId   On-chain dispute ID.
   * @param resolution  Resolution text describing the outcome.
   * @param token       Admin JWT.
   */
  resolveDispute(
    disputeId: string,
    resolution: string,
    token: string,
  ): Observable<ResolveDisputeResult> {
    return this.http.post<ResolveDisputeResult>(
      `${this.baseUrl}/disputes/${disputeId}/resolve`,
      { resolution },
      { headers: this.authHeaders(token) },
    );
  }

  // ── Slash Verifier ─────────────────────────────────────────────────────────

  /**
   * POST /api/admin/verifiers/:address/slash
   * Slashes a verifier's staked balance by the given amount.
   *
   * @param verifierAddress  Stellar public key of the verifier.
   * @param amount           Amount to slash (in stroops as string).
   * @param token            Admin JWT.
   */
  slashVerifier(
    verifierAddress: string,
    amount: string,
    token: string,
  ): Observable<SlashVerifierResult> {
    return this.http.post<SlashVerifierResult>(
      `${this.baseUrl}/verifiers/${verifierAddress}/slash`,
      { amount },
      { headers: this.authHeaders(token) },
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private authHeaders(token: string): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }
}
