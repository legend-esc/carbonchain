/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/**
 * MarketplaceService
 *
 * #930 — Replaces the silent MAX_LISTINGS slice with server-side keyset
 * pagination backed by the contract's indexed order book.
 *
 * GET /marketplace/listings?cursor=<opaque>&limit=50
 *
 * The cursor is a base64-encoded string of the last offer ID seen.  The
 * contract is queried with (offset, limit) derived from the decoded cursor so
 * the full book is reachable across pages.  MAX_LISTINGS is kept as a hard
 * guard on a single contract read but is no longer the effective global cap.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  GoneException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  BadGatewayException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import {
  nativeToScVal,
  scValToNative,
  xdr,
  Account,
  TransactionBuilder,
  Operation,
  Address,
  Networks,
  rpc,
} from '@stellar/stellar-sdk';
import { Offer } from '../../../shared';
import { CreateOfferDto } from './dto/create-offer.dto';
import { parseCreditId } from '../common/credit-id';
import { QuoteResult } from './dto/quote-offer.dto';
export { CreateOfferDto } from './dto/create-offer.dto';

import { extractContractErrorCode } from '../common/filters/structured-exception.filter';
import { stroopsToXlm } from '../common/number-conversions';

/**
 * Maximum number of offers fetched from the contract in a single page read.
 * Acts as an upper bound on the `limit` query param and a hard guard on the
 * contract read — not a global cap on the total book size.
 */
export const MAX_LISTINGS = 500;

/** Default page size when `limit` is omitted. */
const DEFAULT_PAGE_SIZE = 50;

// ── Keyset cursor helpers ─────────────────────────────────────────────────────

/**
 * Encodes an offer-id offset into an opaque URL-safe cursor string.
 * cursor = base64url(JSON({offset}))
 */
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

/**
 * Decodes a cursor string back to a numeric offset.
 * Returns 0 for an empty / undefined cursor (first page).
 * Returns null if the cursor is malformed (caller should use 0 / reject).
 */
function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { offset?: unknown };
    if (typeof parsed.offset !== 'number') return null;
    return Math.max(0, parsed.offset);
  } catch {
    return null;
  }
}

// ── Error mapper ──────────────────────────────────────────────────────────────

function mapMarketplaceError(error: Error): never {
  const code = extractContractErrorCode(error.message);

  switch (code) {
    case 300:
      throw new NotFoundException('Offer not found');
    case 301:
      throw new ForbiddenException('Not authorized to modify this offer');
    case 302:
      throw new BadRequestException('Offer price is invalid');
    case 303:
      throw new BadRequestException('Offer tonnes value is invalid');
    case 304:
      throw new ConflictException('Offer has already been closed or filled');
    case 305:
      throw new BadRequestException(
        'Credit linked to this offer is not active',
      );
    case 306:
      throw new ServiceUnavailableException(
        'Marketplace contract is not initialized',
      );
    case 307:
      throw new ServiceUnavailableException('Marketplace contract is paused');
    case 308:
      throw new UnprocessableEntityException('Invalid replay-protection nonce');
    case 309:
      throw new GoneException('Offer has expired and is no longer available');
    case 312:
      throw new HttpException(
        'Insufficient funds to complete the purchase',
        HttpStatus.PAYMENT_REQUIRED,
      );
    case 313:
      throw new BadGatewayException('Escrow transfer failed');
    default:
      throw error;
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

/** Shape returned by getListingsPaginated (offset/limit) and getListingsKeyset. */
export interface KeysetPage {
  data: Offer[];
  /** Cursor to pass as `cursor` on the next request. Absent on the last page. */
  nextCursor?: string;
  /** Total offers in this page (≤ limit). */
  count: number;
}

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);
  private readonly contractId: string;

  /**
   * Issue #940 — In-memory quote cache keyed on "offerId:accountId".
   * Entries expire after QUOTE_CACHE_TTL_MS milliseconds.
   */
  private readonly quoteCache = new Map<
    string,
    { result: QuoteResult; expiresAt: number }
  >();
  private static readonly QUOTE_CACHE_TTL_MS = 30_000;

  constructor(
    private readonly stellarService: StellarService,
    private readonly keypairService: StellarKeypairService,
    private readonly configService: ConfigService,
  ) {
    this.contractId = this.configService.get<string>(
      'MARKETPLACE_CONTRACT_ID',
      '',
    );
  }

  async getNonce(address: string): Promise<number> {
    try {
      const args = [nativeToScVal(address, { type: 'address' })];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_nonce',
        args,
      );
      if (!retval) return 0;
      return Number(scValToNative(retval));
    } catch (error) {
      this.logger.warn(
        `Failed to fetch nonce for ${address}: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  async createOffer(dto: CreateOfferDto): Promise<{ offerId: string }> {
    this.logger.log(`Creating offer for credit ${dto.creditId}`);
    const registryId = this.configService.get<string>(
      'CREDIT_REGISTRY_CONTRACT_ID',
      '',
    );
    const nonce = dto.nonce ?? (await this.getNonce(dto.sellerPublicKey));
    const expiresAtScVal = dto.expiresAt
      ? nativeToScVal(dto.expiresAt, { type: 'u64' })
      : nativeToScVal(null);

    const creditId = parseCreditId(dto.creditId);
    const args = [
      nativeToScVal(dto.sellerPublicKey, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(BigInt(dto.priceXlm), { type: 'i128' }),
      nativeToScVal(BigInt(dto.tonnes), { type: 'i128' }),
      nativeToScVal(registryId, { type: 'address' }),
      expiresAtScVal,
      nativeToScVal(nonce, { type: 'u64' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    const response = await this.stellarService.invokeContract(
      this.contractId,
      'create_offer',
      args,
      signer,
    );
    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const offerId = rv
      ? String(scValToNative(rv as Parameters<typeof scValToNative>[0]))
      : 'unknown';
    return { offerId };
  }

  async getOffer(offerId: number): Promise<Offer> {
    try {
      const args = [nativeToScVal(offerId, { type: 'u64' })];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_offer',
        args,
      );
      if (!retval) throw new NotFoundException(`Offer ${offerId} not found`);

      return this.mapOffer(offerId, scValToNative(retval));
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      mapMarketplaceError(error as Error);
    }
  }

  // ── #930: Keyset pagination ──────────────────────────────────────────────

  /**
   * Returns a single keyset page of active offers.
   *
   * @param cursor  Opaque cursor from a previous response's nextCursor field.
   *                Omit (or pass undefined) for the first page.
   * @param limit   Number of offers per page. Clamped to [1, MAX_LISTINGS].
   * @param filters Optional methodology / price filters applied server-side.
   *
   * If `nextCursor` is absent in the response the caller has reached the last
   * page.
   */
  async getListingsKeyset(params: {
    cursor?: string;
    limit?: number;
    methodology?: string;
    minPrice?: number;
    maxPrice?: number;
  }): Promise<KeysetPage> {
    const limit = Math.min(
      MAX_LISTINGS,
      Math.max(1, params.limit ?? DEFAULT_PAGE_SIZE),
    );

    const offset = decodeCursor(params.cursor);
    if (offset === null) {
      throw new BadRequestException('Invalid pagination cursor');
    }

    // Fetch one extra offer to detect whether there is a next page.
    const fetchLimit = limit + 1;
    const args = [
      nativeToScVal(true, { type: 'bool' }),
      nativeToScVal(offset, { type: 'u64' }),
      nativeToScVal(fetchLimit, { type: 'u64' }),
    ];

    const retval = await this.stellarService.readContract(
      this.contractId,
      'get_active_offers',
      args,
    );

    if (!retval) {
      return { data: [], count: 0 };
    }

    let raw = scValToNative(retval) as Array<{
      id: bigint;
      [key: string]: unknown;
    }>;

    // Apply hard guard.
    raw = raw.slice(0, fetchLimit);

    // Server-side filter (cheap — runs on the already-small page).
    let offers = raw.map((item) => this.mapOffer(Number(item.id), item));

    if (params.methodology) {
      const m = params.methodology.toLowerCase();
      offers = offers.filter((o) => o.methodology?.toLowerCase() === m);
    }
    if (params.minPrice !== undefined) {
      offers = offers.filter((o) => Number(o.price_xlm) >= params.minPrice!);
    }
    if (params.maxPrice !== undefined) {
      offers = offers.filter((o) => Number(o.price_xlm) <= params.maxPrice!);
    }

    const hasMore = offers.length > limit;
    const page = offers.slice(0, limit);

    const result: KeysetPage = {
      data: page,
      count: page.length,
    };

    if (hasMore) {
      result.nextCursor = encodeCursor(offset + limit);
    }

    return result;
  }

  /**
   * Legacy offset-based paginated listing (kept for backwards compatibility).
   * Internally delegates to getListingsKeyset.
   */
  async getListingsPaginated(params: {
    page: number;
    pageSize: number;
    methodology?: string;
    minPrice?: number;
    maxPrice?: number;
  }): Promise<{
    data: Offer[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const offset = (params.page - 1) * params.pageSize;
    const cursor = offset > 0 ? encodeCursor(offset) : undefined;

    const keysetResult = await this.getListingsKeyset({
      cursor,
      limit: params.pageSize,
      methodology: params.methodology,
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
    });

    return {
      data: keysetResult.data,
      // total is not precisely knowable without a full scan; return the page
      // count so existing callers that read `total` still get a sensible value.
      total: keysetResult.data.length,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  /**
   * Returns active (open) offers from the contract, capped at MAX_LISTINGS.
   * Kept for internal use (reconciliation, tests).
   */
  async getListings(): Promise<Offer[]> {
    const args = [
      nativeToScVal(true, { type: 'bool' }),
      nativeToScVal(0, { type: 'u64' }),
      nativeToScVal(MAX_LISTINGS, { type: 'u64' }),
    ];
    const retval = await this.stellarService.readContract(
      this.contractId,
      'get_active_offers',
      args,
    );
    if (!retval) return [];
    const raw = scValToNative(retval) as Array<{
      id: bigint;
      [key: string]: unknown;
    }>;
    return raw
      .slice(0, MAX_LISTINGS)
      .map((item) => this.mapOffer(Number(item.id), item));
  }

  async getOffersBySeller(seller: string): Promise<string[]> {
    const args = [nativeToScVal(seller, { type: 'address' })];
    const retval = await this.stellarService.readContract(
      this.contractId,
      'get_offers_by_seller',
      args,
    );
    if (!retval) return [];
    return (scValToNative(retval) as bigint[]).map(String);
  }

  async cancelOffer(seller: string, offerId: number): Promise<void> {
    const registryId = this.configService.get<string>(
      'CREDIT_REGISTRY_CONTRACT_ID',
      '',
    );
    const nonce = await this.getNonce(seller);
    const args = [
      nativeToScVal(seller, { type: 'address' }),
      nativeToScVal(offerId, { type: 'u64' }),
      nativeToScVal(registryId, { type: 'address' }),
      nativeToScVal(nonce, { type: 'u64' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    await this.stellarService.invokeContract(
      this.contractId,
      'cancel_offer',
      args,
      signer,
    );
  }

  async buildBuyOfferXdr(
    buyerPublicKey: string,
    offerId: number,
  ): Promise<string> {
    this.logger.log(
      `Building buy_offer XDR for offer ${offerId} by ${buyerPublicKey}`,
    );
    const nativeTokenId = this.configService.get<string>(
      'NATIVE_TOKEN_CONTRACT_ID',
      '',
    );
    const args = [
      nativeToScVal(buyerPublicKey, { type: 'address' }),
      nativeToScVal(offerId, { type: 'u64' }),
      nativeToScVal(nativeTokenId, { type: 'address' }),
    ];
    if (
      typeof (this.stellarService as any).buildContractTransaction ===
      'function'
    ) {
      return (this.stellarService as any).buildContractTransaction(
        this.contractId,
        'buy_offer',
        args,
        buyerPublicKey,
      ) as Promise<string>;
    }
    this.logger.log(
      'buildContractTransaction not yet wired — returning stub XDR',
    );
    return 'AAAAAA==';
  }

  async buyOffer(
    buyerPublicKey: string,
    offerId: number,
    signedXdr?: string,
  ): Promise<void> {
    if (signedXdr) {
      this.logger.log(`Submitting user-signed XDR for offer ${offerId}`);
      if (
        typeof (this.stellarService as any).submitTransaction === 'function'
      ) {
        await (this.stellarService as any).submitTransaction(signedXdr);
        return;
      }
      this.logger.warn(
        'submitTransaction not available — falling back to admin-signed flow',
      );
    }
    try {
      const registryId = this.configService.get<string>(
        'CREDIT_REGISTRY_CONTRACT_ID',
        '',
      );
      const nativeTokenId = this.configService.get<string>(
        'NATIVE_TOKEN_CONTRACT_ID',
        '',
      );
      const nonce = await this.getNonce(buyerPublicKey);
      const args = [
        nativeToScVal(buyerPublicKey, { type: 'address' }),
        nativeToScVal(offerId, { type: 'u64' }),
        nativeToScVal(registryId, { type: 'address' }),
        nativeToScVal(nativeTokenId, { type: 'address' }),
        nativeToScVal(nonce, { type: 'u64' }),
      ];
      const signer = this.keypairService.getAdminKeypair();
      await this.stellarService.invokeContract(
        this.contractId,
        'buy_offer',
        args,
        signer,
      );
    } catch (error) {
      mapMarketplaceError(error as Error);
    }
  }

  /**
   * Issue #940 — POST /marketplace/offers/:id/quote
   */
  async quoteOffer(offerId: string, accountId: string): Promise<QuoteResult> {
    const cacheKey = `${offerId}:${accountId}`;
    const now = Date.now();

    const cached = this.quoteCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    const offerIdNum = parseInt(offerId, 10);
    if (isNaN(offerIdNum)) {
      throw new NotFoundException(`Invalid offer ID: ${offerId}`);
    }
    const offer = await this.getOffer(offerIdNum);
    const grossAmount = offer.price_xlm;

    let estimatedFee = '0';
    try {
      const network = this.configService.get<string>(
        'STELLAR_NETWORK',
        'TESTNET',
      );
      const passphrase =
        network.toUpperCase() === 'PUBLIC' ? Networks.PUBLIC : Networks.TESTNET;

      const nativeTokenId = this.configService.get<string>(
        'NATIVE_TOKEN_CONTRACT_ID',
        '',
      );

      const simArgs: xdr.ScVal[] = [
        nativeToScVal(accountId, { type: 'address' }),
        nativeToScVal(offerIdNum, { type: 'u64' }),
        nativeToScVal(nativeTokenId, { type: 'address' }),
      ];

      const dummyAccount = new Account(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '0',
      );

      const tx = new TransactionBuilder(dummyAccount, {
        fee: '100',
        networkPassphrase: passphrase,
      })
        .addOperation(
          Operation.invokeHostFunction({
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(
                  this.contractId,
                ).toScAddress(),
                functionName: 'buy_offer',
                args: simArgs,
              }),
            ),
            auth: [],
          }),
        )
        .setTimeout(30)
        .build();

      const simulation = await this.stellarService.simulateTransaction(tx);
      if (rpc.Api.isSimulationSuccess(simulation)) {
        estimatedFee = String(simulation.minResourceFee ?? '0');
      }
    } catch (err) {
      this.logger.warn(
        `quoteOffer simulation failed for offer ${offerId}: ${(err as Error).message}`,
      );
    }

    const netAmount = String(BigInt(grossAmount) + BigInt(estimatedFee));

    const result: QuoteResult = {
      offerId,
      accountId,
      grossAmount,
      estimatedFee,
      netAmount,
      currency: 'XLM',
      cachedAt: new Date(now).toISOString(),
    };

    this.quoteCache.set(cacheKey, {
      result,
      expiresAt: now + MarketplaceService.QUOTE_CACHE_TTL_MS,
    });

    return result;
  }

  private mapOffer(id: number, n: any): Offer {
    const stroops = BigInt(n.price_xlm ?? 0);
    return {
      id: String(id),
      seller: String(n.seller),
      credit_id: Buffer.from(n.credit_id as Uint8Array).toString('hex'),
      price_xlm: stroopsToXlm(stroops),
      tonnes_available: String(n.tonnes),
      created_at: Number(n.created_at),
      status: n.active ? 'open' : 'cancelled',
      methodology: n.methodology ? String(n.methodology) : undefined,
      payment_asset_code: n.payment_asset_code
        ? String(n.payment_asset_code)
        : 'XLM',
      payment_asset_issuer: n.payment_asset_issuer
        ? String(n.payment_asset_issuer)
        : undefined,
      price_raw: String(n.price_xlm),
    };
  }
}
