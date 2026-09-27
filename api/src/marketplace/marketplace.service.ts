/* eslint-disable @typescript-eslint/no-unsafe-member-access */
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
// #937 — use canonical stroop→XLM conversion instead of inline magic constants
import { stroopsToXlm } from '../common/number-conversions';

/**
 * Maximum number of offers fetched from the contract in a single read.
 * Prevents unbounded memory usage as the order book grows.
 * Increase and add cursor-based pagination once the contract supports it.
 */
export const MAX_LISTINGS = 500;

/**
 * Maps Soroban marketplace contract error codes to HTTP exceptions.
 * Codes are extracted from the Soroban "Error(Contract, #NNN)" message format.
 * Error code reference: docs/features/ERROR_CODES_REFERENCE.md (Marketplace 300-313)
 */
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
      // Re-throw unrecognized errors so the global filter handles them.
      throw error;
  }
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

  /** Returns paginated active offers with optional filters. */
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
    let offers = await this.getListings();

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

    const total = offers.length;
    const start = (params.page - 1) * params.pageSize;
    return {
      data: offers.slice(start, start + params.pageSize),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  /** Returns active (open) offers from the contract, capped at MAX_LISTINGS. */
  async getListings(): Promise<Offer[]> {
    // Pass offset=0 and limit=MAX_LISTINGS so that, once the contract supports
    // cursor-based reads, we can forward these args directly and remove the
    // in-process slice. For now they act as a hard cap against unbounded reads.
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
    // Hard cap in case the contract ignores the limit arg (older deployment).
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

  async buildBuyOfferXdr(buyerPublicKey: string, offerId: number): Promise<string> {
    this.logger.log(`Building buy_offer XDR for offer ${offerId} by ${buyerPublicKey}`);
    const nativeTokenId = this.configService.get<string>(
      'NATIVE_TOKEN_CONTRACT_ID',
      '',
    );
    const args = [
      nativeToScVal(buyerPublicKey, { type: 'address' }),
      nativeToScVal(offerId, { type: 'u64' }),
      nativeToScVal(nativeTokenId, { type: 'address' }),
    ];
    // Use buildContractTransaction if available, otherwise return stub
    if (typeof (this.stellarService as any).buildContractTransaction === 'function') {
      return (this.stellarService as any).buildContractTransaction(
        this.contractId,
        'buy_offer',
        args,
        buyerPublicKey,
      ) as Promise<string>;
    }
    this.logger.log('buildContractTransaction not yet wired — returning stub XDR');
    return 'AAAAAA==';
  }

  async buyOffer(buyerPublicKey: string, offerId: number, signedXdr?: string): Promise<void> {
    if (signedXdr) {
      this.logger.log(`Submitting user-signed XDR for offer ${offerId}`);
      if (typeof (this.stellarService as any).submitTransaction === 'function') {
        await (this.stellarService as any).submitTransaction(signedXdr);
        return;
      }
      this.logger.warn('submitTransaction not available — falling back to admin-signed flow');
    }
    // Admin-signed fallback
    const nativeTokenId = this.configService.get<string>(
      'NATIVE_TOKEN_CONTRACT_ID',
      '',
    );
    const args = [
      nativeToScVal(buyerPublicKey, { type: 'address' }),
      nativeToScVal(offerId, { type: 'u64' }),
      nativeToScVal(nativeTokenId, { type: 'address' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    await this.stellarService.invokeContract(
      this.contractId,
      'buy_offer',
      args,
      signer,
    );
  async buyOffer(buyerPublicKey: string, offerId: number): Promise<void> {
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
   *
   * Simulates the `buy_offer` transaction to return a deterministic price
   * breakdown (gross amount, estimated resource fee, net total) without
   * committing any on-chain state.
   *
   * Results are cached per (offerId, accountId) for QUOTE_CACHE_TTL_MS ms so
   * that back-to-back calls within the same window return consistent numbers.
   */
  async quoteOffer(offerId: string, accountId: string): Promise<QuoteResult> {
    const cacheKey = `${offerId}:${accountId}`;
    const now = Date.now();

    // Return cached result if still fresh
    const cached = this.quoteCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    // Fetch the offer to get its price
    const offerIdNum = parseInt(offerId, 10);
    if (isNaN(offerIdNum)) {
      throw new NotFoundException(`Invalid offer ID: ${offerId}`);
    }
    const offer = await this.getOffer(offerIdNum);
    const grossAmount = offer.price_xlm;

    let estimatedFee = '0';
    try {
      // Build a simulation transaction for buy_offer (signing-free)
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
      // Best-effort quote: return zero fee rather than failing the entire request
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
    // #937 — price_xlm is stored in stroops (i128); convert to a human-readable
    // XLM string via the canonical util so there is a single source of truth.
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
      payment_asset_code: n.payment_asset_code ? String(n.payment_asset_code) : 'XLM',
      payment_asset_issuer: n.payment_asset_issuer ? String(n.payment_asset_issuer) : undefined,
      price_raw: String(n.price_xlm),
    };
  }
}
