import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Issue #940 — POST /marketplace/offers/:id/quote
 * Request body: the buyer's account ID used to simulate the transaction.
 */
export class QuoteOfferDto {
  @ApiProperty({ description: 'Stellar account ID of the prospective buyer' })
  @IsString()
  @IsNotEmpty()
  accountId: string;
}

/**
 * Quote result returned to the caller.
 * All monetary amounts are in stroops (string to avoid JS precision loss).
 */
export interface QuoteResult {
  /** Offer ID that was quoted. */
  offerId: string;
  /** Buyer account ID used in the simulation. */
  accountId: string;
  /** Offer price (gross amount before fees), in stroops. */
  grossAmount: string;
  /** Estimated Soroban resource fee from the simulation, in stroops. */
  estimatedFee: string;
  /** grossAmount + estimatedFee, in stroops. */
  netAmount: string;
  /** Asset code — always 'XLM' for native-token offers. */
  currency: string;
  /** ISO-8601 timestamp at which the quote was computed / retrieved from cache. */
  cachedAt: string;
}
