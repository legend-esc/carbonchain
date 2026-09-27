/**
 * Issue #943 — Certificate response DTO that includes the ledger anchor.
 *
 * `ledgerSeq` is the Stellar ledger sequence number at which the retirement
 * transaction was permanently anchored on-chain.  Consumers can independently
 * verify the retirement by fetching the ledger at this sequence from any
 * Horizon node and confirming the transaction hash matches.
 *
 * The field is `null` for legacy retirement records that pre-date issue #943.
 */
export class CertificateResponseDto {
  /** Retirement record ID (hex-encoded BytesN<32>). */
  id: string;

  /** Credit ID that was retired (hex-encoded BytesN<32>). */
  credit_id: string;

  /** Stellar account address of the buyer who retired the credit. */
  buyer: string;

  /** Tonnes retired as a string-encoded integer (1 tonne = 1_000_000 units). */
  tonnes_retired: string;

  /** Human-readable reason supplied at retirement. */
  reason: string;

  /** Unix timestamp (seconds) of the ledger close that processed the retirement. */
  retired_at: number;

  /** Stellar transaction hash of the retirement transaction. */
  tx_hash: string;

  /** IPFS CID of the retirement certificate PDF. Empty string for legacy records. */
  certificate_ipfs_hash: string;

  /** Vintage year of the retired credit (e.g. 2024). Null for legacy records. */
  vintage_year: number | null;

  /**
   * Issue #943 — Stellar ledger sequence number at which this retirement was
   * anchored on-chain.  Null for legacy records that pre-date this field.
   *
   * Use this value to independently verify the retirement:
   *   GET https://horizon.stellar.org/ledgers/<ledgerSeq>/transactions
   * and confirm that the returned transaction hash matches `tx_hash`.
   */
  ledgerSeq: number | null;
}
