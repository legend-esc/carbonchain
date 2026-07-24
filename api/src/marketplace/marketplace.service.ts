/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { Offer } from '../shared';
import { CreateOfferDto } from './dto/create-offer.dto';
export { CreateOfferDto } from './dto/create-offer.dto';

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);
  private readonly contractId: string;

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

  async createOffer(dto: CreateOfferDto): Promise<{ offerId: string }> {
    this.logger.log(`Creating offer for credit ${dto.creditId}`);
    const args = [
      nativeToScVal(dto.sellerPublicKey, { type: 'address' }),
      nativeToScVal(Buffer.from(dto.creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(BigInt(dto.priceXlm), { type: 'i128' }),
      nativeToScVal(BigInt(dto.tonnes), { type: 'i128' }),
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
    const args = [nativeToScVal(offerId, { type: 'u64' })];
    const retval = await this.stellarService.readContract(
      this.contractId,
      'get_offer',
      args,
    );
    if (!retval) throw new NotFoundException(`Offer ${offerId} not found`);

    return this.mapOffer(offerId, scValToNative(retval));
  }

  /** Returns paginated active offers with optional filters. */
  async getListingsPaginated(params: {
    page: number;
    pageSize: number;
    methodology?: string;
    minPrice?: number;
    maxPrice?: number;
  }): Promise<{ data: Offer[]; total: number; page: number; pageSize: number }> {
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

  /** Returns all active (open) offers from the contract. */
  async getListings(): Promise<Offer[]> {
    const args = [nativeToScVal(true, { type: 'bool' })];
    try {
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
      return raw.map((item) => this.mapOffer(Number(item.id), item));
    } catch {
      return [];
    }
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
    const args = [
      nativeToScVal(seller, { type: 'address' }),
      nativeToScVal(offerId, { type: 'u64' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    await this.stellarService.invokeContract(
      this.contractId,
      'cancel_offer',
      args,
      signer,
    );
  }

  async buyOffer(buyerPublicKey: string, offerId: number): Promise<void> {
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
  }

  private mapOffer(id: number, n: any): Offer {
    return {
      id: String(id),
      seller: String(n.seller),
      credit_id: Buffer.from(n.credit_id as Uint8Array).toString('hex'),
      price_xlm: String(n.price_xlm),
      tonnes_available: String(n.tonnes),
      created_at: Number(n.created_at),
      status: n.active ? 'open' : 'cancelled',
      methodology: n.methodology ? String(n.methodology) : undefined,
    };
  }
}
