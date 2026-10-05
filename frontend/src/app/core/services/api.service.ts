import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  CreditMetadata,
  ProjectProfile,
  Offer,
  VerifierReputation,
  VerifierApplicationEntity,
} from '@shared';

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
  name?: string | null;
  capabilities?: string[];
  reputation?: {
    approvalCount: number;
    disputeCount: number;
  };
  registeredAt?: Date;
}

export interface AdminStats {
  totalCredits: number;
  totalRetirements: number;
  activeVerifiers: number;
  paused: boolean;
}

export interface VerifierConfig {
  methodologies?: string[];
  geographies?: string[];
}

export interface ProvenanceEvent {
  action: string;
  actor: string;
  timestamp: number;
  tx_hash?: string;
  detail?: string;
}

/** On-chain verification result returned by GET /certificates/:id/verify */
export interface CertificateVerification {
  id: string;
  credit_id: string;
  buyer: string;
  tonnes_retired: string;
  reason: string;
  retired_at: number;
  tx_hash: string;
  verified: boolean;
  ledger_sequence?: number;
  ipfs_status?: 'available' | 'unavailable' | 'unknown';
  mismatch_reason?: string;
}

/**
 * A row from the indexed contract-event log (issue #958).
 * Mirrors `SorobanEvent` in api/src/events/events.service.ts.
 */
export interface SorobanEvent {
  id: string;
  /** Event topic, e.g. 'OfferListed' / 'OfferPriceChanged' / 'OfferFilled'. */
  type: string;
  contractId: string;
  ledger: number;
  /** Unix seconds. */
  timestamp: number;
  data: Record<string, unknown>;
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
      headers: this.authHeaders(token).set('Idempotency-Key', crypto.randomUUID()),
    });
  }

  // ── Credits ───────────────────────────────────────────────────────────────

  /** GET /credits/:id */
  getCredit(id: string): Observable<CreditMetadata> {
    return this.http.get<CreditMetadata>(`${this.baseUrl}/credits/${id}`);
  }

  /** POST /credits/:id/split */
  splitCredit(
    creditId: string,
    splitTonnes: string,
    token: string,
  ): Observable<{ childCredit1: string; childCredit2: string }> {
    return this.http.post<{ childCredit1: string; childCredit2: string }>(
      `${this.baseUrl}/credits/${creditId}/split`,
      { splitTonnes },
      { headers: this.authHeaders(token) },
    );
  }

  /** POST /credits/merge */
  mergeCredits(
    creditIds: string[],
    token: string,
  ): Observable<{ mergedCreditId: string }> {
    return this.http.post<{ mergedCreditId: string }>(
      `${this.baseUrl}/credits/merge`,
      { creditIds },
      { headers: this.authHeaders(token) },
    );
  }

  /** GET /credits/:id/provenance */
  getCreditProvenance(id: string): Observable<ProvenanceEvent[]> {
    return this.http.get<ProvenanceEvent[]>(`${this.baseUrl}/credits/${id}/provenance`);
  }

  /** GET /credits/project/:projectId */
  listCreditsByProject(projectId: string): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/credits/project/${projectId}`);
  }

  /** GET /credits/owner/:owner — paginated list of credit IDs owned by `owner` */
  listCreditsByOwner(
    owner: string,
    offset = 0,
    limit = 50,
  ): Observable<{ data: string[]; offset: number; limit: number }> {
    const params = { offset: String(offset), limit: String(limit) };
    return this.http.get<{ data: string[]; offset: number; limit: number }>(
      `${this.baseUrl}/credits/owner/${owner}`,
      { params },
    );
  }

  // ── Marketplace ───────────────────────────────────────────────────────────

  /** GET /marketplace/listings — server-side paginated and filtered */
  getListings(params?: {
    page?: number;
    pageSize?: number;
    methodology?: string;
    minPrice?: number;
    maxPrice?: number;
  }): Observable<{ data: Offer[]; total: number; page: number; pageSize: number }> {
    const httpParams: Record<string, string> = {};
    if (params?.page) httpParams['page'] = String(params.page);
    if (params?.pageSize) httpParams['pageSize'] = String(params.pageSize);
    if (params?.methodology) httpParams['methodology'] = params.methodology;
    if (params?.minPrice !== undefined) httpParams['minPrice'] = String(params.minPrice);
    if (params?.maxPrice !== undefined) httpParams['maxPrice'] = String(params.maxPrice);
    return this.http.get<{ data: Offer[]; total: number; page: number; pageSize: number }>(
      `${this.baseUrl}/marketplace/listings`,
      { params: httpParams },
    );
  }

  /**
   * GET /marketplace/listings — cursor-based pagination.
   * Pass `cursor` from a previous response's `next_cursor` to get the next page.
   * When `cursor` is omitted the first page is returned.
   */
  getListingsCursor(
    params: Record<string, string>,
  ): Observable<{ data: Offer[]; next_cursor: string | null; limit: number }> {
    return this.http.get<{ data: Offer[]; next_cursor: string | null; limit: number }>(
      `${this.baseUrl}/marketplace/listings`,
      { params },
    );
  }

  /** GET /marketplace/offer/:id */
  getOffer(id: number): Observable<Offer> {
    return this.http.get<Offer>(`${this.baseUrl}/marketplace/offer/${id}`);
  }

  /** GET /marketplace/seller/:address */
  getOffersBySeller(address: string): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/marketplace/seller/${address}`);
  }

  /** GET /marketplace/offer/:id/quote */
  getBuyQuote(offerId: number): Observable<import('@shared').BuyQuote> {
    return this.http.get<import('@shared').BuyQuote>(
      `${this.baseUrl}/marketplace/offer/${offerId}/quote`,
    );
  }

  /**
   * POST /marketplace/offer/:id/buy with signed XDR from user wallet.
   *
   * `buyerPublicKey` and `signedXdr` are optional so the offer-detail flow
   * (client-built + Freighter-signed XDR) and the simplified marketplace buy
   * flow (server-side signing) can share one endpoint method.
   */
  buyOffer(
    offerId: number,
    buyerPublicKey?: string,
    signedXdr?: string,
    token = '',
  ): Observable<void> {
    return this.http.post<void>(
      `${this.baseUrl}/marketplace/offer/${offerId}/buy`,
      { buyerPublicKey, signedXdr },
      { headers: this.authHeaders(token) },
    );
  }

  /** GET /marketplace/offer/:id/xdr — get unsigned buy XDR for wallet signing */
  getBuyOfferXdr(
    offerId: number,
    buyerPublicKey: string,
    token: string,
  ): Observable<{ xdr: string }> {
    return this.http.get<{ xdr: string }>(`${this.baseUrl}/marketplace/offer/${offerId}/xdr`, {
      params: { buyerPublicKey },
      headers: this.authHeaders(token),
    });
  }

  /** DELETE /marketplace/offer/:id/seller/:address — cancel offer */
  cancelOffer(offerId: number, sellerAddress: string, token: string): Observable<void> {
    return this.http.delete<void>(
      `${this.baseUrl}/marketplace/offer/${offerId}/seller/${sellerAddress}`,
      { headers: this.authHeaders(token) },
    );
  }

  // ── Retirement ────────────────────────────────────────────────────────────

  /** POST /retirement */
  retireCredit(
    body: { buyerPublicKey: string; creditId: string; tonnes: string; reason: string },
    token: string,
  ): Observable<{ retirementId: string }> {
    return this.http.post<{ retirementId: string }>(`${this.baseUrl}/retirement`, body, {
      headers: this.authHeaders(token).set('Idempotency-Key', crypto.randomUUID()),
    });
  }

  /** POST /retirement/batch */
  batchRetire(
    body: { buyerPublicKey: string; creditIds: string[]; tonnes: string[]; reason: string },
    token: string,
  ): Observable<{ succeeded: string[]; failed: { id: string; reason: string }[] }> {
    return this.http.post<{ succeeded: string[]; failed: { id: string; reason: string }[] }>(
      `${this.baseUrl}/retirement/batch`,
      body,
      { headers: this.authHeaders(token).set('Idempotency-Key', crypto.randomUUID()) },
    );
  }

  /** GET /retirement/:id */
  getRetirement(id: string): Observable<import('@shared').RetirementRecord> {
    return this.http.get<import('@shared').RetirementRecord>(`${this.baseUrl}/retirement/${id}`);
  }

  /** GET /certificates/:id — fetch a retirement certificate by ID */
  getCertificate(id: string): Observable<import('@shared').RetirementRecord> {
    return this.http.get<import('@shared').RetirementRecord>(`${this.baseUrl}/certificates/${id}`);
  }

  /** GET /certificates/:id/download — returns a PDF blob */
  downloadCertificate(id: string, token: string): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/certificates/${id}/download`, {
      headers: this.authHeaders(token),
      responseType: 'blob',
    });
  }

  /** GET /certificates/:id/verify — on-chain certificate verification */
  verifyCertificate(id: string): Observable<CertificateVerification> {
    return this.http.get<CertificateVerification>(`${this.baseUrl}/certificates/${id}/verify`);
  }

  /** POST /marketplace/offer */
  createOffer(
    body: { sellerPublicKey: string; creditId: string; priceXlm: string; tonnes: string },
    token: string,
  ): Observable<{ offerId: string }> {
    return this.http.post<{ offerId: string }>(`${this.baseUrl}/marketplace/offer`, body, {
      headers: this.authHeaders(token).set('Idempotency-Key', crypto.randomUUID()),
    });
  }

  /** GET /retirement/certificates/:id/download — returns PDF blob (requires JWT) */
  downloadRetirementCertificate(id: string, token: string): Observable<Blob> {
    return this.http.get(`${this.baseUrl}/retirement/certificates/${id}/download`, {
      headers: this.authHeaders(token),
      responseType: 'blob',
    });
  }

  /** GET /retirement/certificates/:id/verify — on-chain verification (public) */
  verifyCertificateById(id: string): Observable<import('@shared').CertificateVerification> {
    return this.http.get<import('@shared').CertificateVerification>(
      `${this.baseUrl}/retirement/certificates/${id}/verify`,
    );
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /**
   * GET /events — indexed contract events, keyset-paginated (issue #931).
   *
   * Issue #958 — the price-history chart and the watchlist alerts are both fed
   * from this index. Pass `eventType` to narrow to a single topic and
   * `beforeCursor` to walk backwards through history.
   */
  getEvents(params?: {
    contractId?: string;
    eventType?: string;
    limit?: number;
    beforeCursor?: string;
  }): Observable<{ events: SorobanEvent[]; nextCursor: string | null }> {
    const httpParams: Record<string, string> = {};
    if (params?.contractId) httpParams['contractId'] = params.contractId;
    if (params?.eventType) httpParams['eventType'] = params.eventType;
    if (params?.limit !== undefined) httpParams['limit'] = String(params.limit);
    if (params?.beforeCursor) httpParams['beforeCursor'] = params.beforeCursor;
    return this.http.get<{ events: SorobanEvent[]; nextCursor: string | null }>(
      `${this.baseUrl}/events`,
      { params: httpParams },
    );
  }

  // ── Verifiers ─────────────────────────────────────────────────────────────

  /** GET /verifiers */
  listVerifiers(): Observable<VerifierInfo[]> {
    return this.http.get<VerifierInfo[]>(`${this.baseUrl}/verifiers`);
  }

  /** GET /verifiers/min-stake */
  getMinStake(): Observable<{ minStake: string }> {
    return this.http.get<{ minStake: string }>(`${this.baseUrl}/verifiers/min-stake`);
  }

  /** GET /verifiers/:address/stake */
  getVerifierStake(address: string): Observable<{ address: string; stake: string }> {
    return this.http.get<{ address: string; stake: string }>(
      `${this.baseUrl}/verifiers/${address}/stake`,
    );
  }

  /** GET /verifiers/:address/reputation */
  getVerifierReputation(address: string): Observable<VerifierReputation> {
    return this.http.get<VerifierReputation>(`${this.baseUrl}/verifiers/${address}/reputation`);
  }

  /** GET /verifiers/:address/pending — pending credits for a verifier (admin or self) */
  getVerifierPending(address: string): Observable<CreditMetadata[]> {
    return this.http.get<CreditMetadata[]>(`${this.baseUrl}/verifiers/${address}/pending`);
  }

  /** GET /verifiers/:address/history — approval history for a verifier (admin or self) */
  getVerifierHistory(address: string): Observable<CreditMetadata[]> {
    return this.http.get<CreditMetadata[]>(`${this.baseUrl}/verifiers/${address}/history`);
  }

  /** GET /oracle/:projectId/history */
  getOracleHistory(
    projectId: string,
    page = 1,
    pageSize = 20,
  ): Observable<{
    data: import('@shared').MrvDataPoint[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const params: Record<string, string> = { page: String(page), pageSize: String(pageSize) };
    return this.http.get<{
      data: import('@shared').MrvDataPoint[];
      total: number;
      page: number;
      pageSize: number;
    }>(`${this.baseUrl}/oracle/${projectId}/history`, { params });
  }

  /** GET /oracle/:projectId/aggregate */
  getOracleAggregate(projectId: string): Observable<{
    totalTonnes: string;
    readingCount: number;
    anomalyCount: number;
    latestReading: import('@shared').MrvDataPoint | null;
    monthlyBreakdown: {
      month: string;
      totalTonnes: string;
      readingCount: number;
      anomalyCount: number;
    }[];
  }> {
    return this.http.get<{
      totalTonnes: string;
      readingCount: number;
      anomalyCount: number;
      latestReading: import('@shared').MrvDataPoint | null;
      monthlyBreakdown: {
        month: string;
        totalTonnes: string;
        readingCount: number;
        anomalyCount: number;
      }[];
    }>(`${this.baseUrl}/oracle/${projectId}/aggregate`);
  }

  /** POST /verifiers/applications */
  submitVerifierApplication(body: {
    address: string;
    name: string;
    capabilities: string[];
    documentsCid: string;
    stakeToken: string;
    stakeAmount: string;
  }): Observable<VerifierApplicationEntity> {
    return this.http.post<VerifierApplicationEntity>(
      `${this.baseUrl}/verifiers/applications`,
      body,
    );
  }

  /** GET /verifiers/applications/:address */
  getVerifierApplication(address: string): Observable<VerifierApplicationEntity | null> {
    return this.http.get<VerifierApplicationEntity | null>(
      `${this.baseUrl}/verifiers/applications/${address}`,
    );
  }

  /** GET /verifiers/admin/applications */
  listVerifierApplications(
    token: string,
    status?: string,
  ): Observable<VerifierApplicationEntity[]> {
    const params: Record<string, string> = {};
    if (status) params['status'] = status;
    return this.http.get<VerifierApplicationEntity[]>(
      `${this.baseUrl}/verifiers/admin/applications`,
      {
        params,
        headers: this.authHeaders(token),
      },
    );
  }

  /** POST /verifiers/admin/applications/:address/review */
  reviewVerifierApplication(
    address: string,
    status: string,
    token: string,
  ): Observable<VerifierApplicationEntity | null> {
    return this.http.post<VerifierApplicationEntity | null>(
      `${this.baseUrl}/verifiers/admin/applications/${address}/review`,
      { status },
      { headers: this.authHeaders(token) },
    );
  }

  /**
   * POST /verifiers/:address/stake/deposit
   * Deposit stake on behalf of a verifier. Requires JWT.
   */
  depositStake(
    address: string,
    body: { tokenId: string; amount: string; nonce: string },
    token: string,
  ): Observable<{ address: string; stake: string }> {
    return this.http.post<{ address: string; stake: string }>(
      `${this.baseUrl}/verifiers/${address}/stake/deposit`,
      body,
      { headers: this.authHeaders(token) },
    );
  }

  /**
   * POST /verifiers/:address/stake/withdraw
   * Withdraw unbonded stake once the 30-day unbonding period has elapsed. Requires JWT.
   */
  withdrawStake(
    address: string,
    body: { tokenId: string; nonce: string },
    token: string,
  ): Observable<{ withdrawn: boolean; address: string }> {
    return this.http.post<{ withdrawn: boolean; address: string }>(
      `${this.baseUrl}/verifiers/${address}/stake/withdraw`,
      body,
      { headers: this.authHeaders(token) },
    );
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

  /**
   * POST /admin/methodologies — register a new carbon credit methodology.
   * Requires admin JWT.
   */
  registerMethodology(
    name: string,
    description: string,
    token: string,
  ): Observable<{ registered: boolean; name: string; description: string }> {
    return this.http.post<{ registered: boolean; name: string; description: string }>(
      `${this.baseUrl}/admin/methodologies`,
      { name, description },
      { headers: this.authHeaders(token) },
    );
  }

  /**
   * GET /admin/nonce/:address — fetch the current replay-protection nonce.
   * Must be called before every mutating admin action.
   */
  getAdminNonce(address: string, token: string): Observable<{ address: string; nonce: number }> {
    return this.http.get<{ address: string; nonce: number }>(
      `${this.baseUrl}/admin/nonce/${address}`,
      { headers: this.authHeaders(token) },
    );
  }

  /**
   * POST /admin/required-approvals — set the minimum verifier approval threshold.
   * Requires admin JWT.
   */
  setRequiredApprovals(
    threshold: number,
    token: string,
  ): Observable<{ requiredApprovals: number }> {
    return this.http.post<{ requiredApprovals: number }>(
      `${this.baseUrl}/admin/required-approvals`,
      { threshold },
      { headers: this.authHeaders(token) },
    );
  }

  /**
   * POST /admin/min-stake — update the minimum stake required to register as a verifier.
   * Requires admin JWT.
   */
  setMinStake(amount: string, nonce: string, token: string): Observable<{ minStake: string }> {
    return this.http.post<{ minStake: string }>(
      `${this.baseUrl}/admin/min-stake`,
      { amount, nonce },
      { headers: this.authHeaders(token) },
    );
  }

  /**
   * POST /admin/verifiers/:address/slash — slash 10% of a verifier's stake as penalty.
   * Requires admin JWT.
   */
  slashVerifier(
    address: string,
    creditId: string,
    nonce: string,
    token: string,
  ): Observable<{ slashed: boolean; verifier: string; creditId: string }> {
    return this.http.post<{ slashed: boolean; verifier: string; creditId: string }>(
      `${this.baseUrl}/admin/verifiers/${address}/slash`,
      { creditId, nonce },
      { headers: this.authHeaders(token) },
    );
  }

  /**
   * POST /admin/pause — pause all contract operations.
   * Requires admin JWT.
   */
  pauseContract(token: string): Observable<{ paused: boolean }> {
    return this.http.post<{ paused: boolean }>(
      `${this.baseUrl}/admin/pause`,
      {},
      { headers: this.authHeaders(token) },
    );
  }

  /**
   * POST /admin/unpause — resume all contract operations.
   * Requires admin JWT.
   */
  unpauseContract(token: string): Observable<{ paused: boolean }> {
    return this.http.post<{ paused: boolean }>(
      `${this.baseUrl}/admin/unpause`,
      {},
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
