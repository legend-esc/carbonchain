import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { CreditMetadata, ProjectProfile, Offer } from '@shared';

// ---------------------------------------------------------------------------
// Response types mirroring the NestJS controllers
// ---------------------------------------------------------------------------

export interface ChallengeResponse {
  transaction: string;
  network_passphrase: string;
}

export interface TokenResponse {
  access_token: string;
}

export interface MeResponse {
  account: string;
}

export interface VerifierInfo {
  address: string;
}

export interface AdminStats {
  totalCredits: number;
  totalRetirements: number;
  activeVerifiers: number;
}

export interface VerifierConfig {
  methodologies?: string[];
  geographies?: string[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  /** Base URL — override via environment files as needed. */
  private readonly baseUrl = '/api';

  // ── Auth ──────────────────────────────────────────────────────────────────

  /** GET /auth/challenge?account=G... */
  getChallenge(account: string): Observable<ChallengeResponse> {
    return this.http.get<ChallengeResponse>(`${this.baseUrl}/auth/challenge`, {
      params: { account },
    });
  }

  /** POST /auth/token — exchange signed XDR for a JWT. */
  getToken(signedTransaction: string): Observable<TokenResponse> {
    return this.http.post<TokenResponse>(`${this.baseUrl}/auth/token`, {
      transaction: signedTransaction,
    });
  }

  /** GET /auth/me — returns the authenticated account (requires JWT). */
  getMe(token: string): Observable<MeResponse> {
    return this.http.get<MeResponse>(`${this.baseUrl}/auth/me`, {
      headers: this.authHeaders(token),
    });
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  /** GET /projects */
  listProjects(): Observable<ProjectProfile[]> {
    return this.http.get<ProjectProfile[]>(`${this.baseUrl}/projects`);
  }

  /** GET /projects/:id */
  getProject(id: string): Observable<ProjectProfile> {
    return this.http.get<ProjectProfile>(`${this.baseUrl}/projects/${id}`);
  }

  /** POST /projects */
  createProject(data: Omit<ProjectProfile, 'id'>, token: string): Observable<ProjectProfile> {
    return this.http.post<ProjectProfile>(`${this.baseUrl}/projects`, data, {
      headers: this.authHeaders(token),
    });
  }

  // ── Credits ───────────────────────────────────────────────────────────────

  /** GET /credits/:id */
  getCredit(id: string): Observable<CreditMetadata> {
    return this.http.get<CreditMetadata>(`${this.baseUrl}/credits/${id}`);
  }

  /** GET /credits/project/:projectId */
  listCreditsByProject(projectId: string): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/credits/project/${projectId}`);
  }

  // ── Marketplace ───────────────────────────────────────────────────────────

  /** GET /marketplace/listings — all active offers */
  getListings(): Observable<Offer[]> {
    return this.http.get<Offer[]>(`${this.baseUrl}/marketplace/listings`);
  }

  /** GET /marketplace/offer/:id */
  getOffer(id: number): Observable<Offer> {
    return this.http.get<Offer>(`${this.baseUrl}/marketplace/offer/${id}`);
  }

  /** GET /marketplace/seller/:address */
  getOffersBySeller(address: string): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/marketplace/seller/${address}`);
  }

  // ── Retirement ────────────────────────────────────────────────────────────

  /** POST /retirement */
  retireCredit(
    body: { buyerPublicKey: string; creditId: string; tonnes: string; reason: string },
    token: string,
  ): Observable<{ retirementId: string }> {
    return this.http.post<{ retirementId: string }>(`${this.baseUrl}/retirement`, body, {
      headers: this.authHeaders(token),
    });
  }

  /** GET /retirement/:id */
  getRetirement(id: string): Observable<import('@shared').RetirementRecord> {
    return this.http.get<import('@shared').RetirementRecord>(`${this.baseUrl}/retirement/${id}`);
  }

  /** POST /marketplace/offer */
  createOffer(
    body: { sellerPublicKey: string; creditId: string; priceXlm: string; tonnes: string },
    token: string,
  ): Observable<{ offerId: string }> {
    return this.http.post<{ offerId: string }>(`${this.baseUrl}/marketplace/offer`, body, {
      headers: this.authHeaders(token),
    });
  }

  // ── Verifiers ─────────────────────────────────────────────────────────────

  /** GET /verifiers */
  listVerifiers(): Observable<VerifierInfo[]> {
    return this.http.get<VerifierInfo[]>(`${this.baseUrl}/verifiers`);
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  /** GET /admin/stats */
  getAdminStats(token: string): Observable<AdminStats> {
    return this.http.get<AdminStats>(`${this.baseUrl}/admin/stats`, {
      headers: this.authHeaders(token),
    });
  }

  /** POST /admin/verifiers/register */
  registerVerifier(
    address: string,
    token: string,
  ): Observable<{ registered: boolean; address: string }> {
    return this.http.post<{ registered: boolean; address: string }>(
      `${this.baseUrl}/admin/verifiers/register`,
      { address },
      { headers: this.authHeaders(token) },
    );
  }

  /** POST /admin/verifiers/:id/suspend */
  suspendVerifier(id: string, token: string): Observable<{ suspended: boolean }> {
    return this.http.post<{ suspended: boolean }>(
      `${this.baseUrl}/admin/verifiers/${id}/suspend`,
      {},
      { headers: this.authHeaders(token) },
    );
  }

  /** POST /admin/verifiers/:id/configure */
  configureVerifier(
    id: string,
    config: VerifierConfig,
    token: string,
  ): Observable<{ configured: boolean; verifierId: string }> {
    return this.http.post<{ configured: boolean; verifierId: string }>(
      `${this.baseUrl}/admin/verifiers/${id}/configure`,
      config,
      { headers: this.authHeaders(token) },
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private authHeaders(token: string): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }
}

export interface VerifierRecord {
  address: string;
  name: string;
  status: 'pending' | 'approved' | 'removed';
  registered_at: number;
}
