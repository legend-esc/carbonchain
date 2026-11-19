# Offer maintenance, vintage limits, and batch retirement events

All credit quantities below use scaled units: 1 tonne = 1,000,000 units,
with a minimum increment of 100,000 units (0.1 tonne).

## Expired offers

`sweep_expired_offers(caller: Address, max_count: u32) -> u32` is available
to any authenticated caller. It inspects at most `min(max_count, 25)` active
index entries, starting from a saved cursor. Repeated calls eventually reach
entries behind live offers. The return value counts offers closed, so a call
may return zero while advancing past live entries. Zero requests do no work.

An offer expires only when the ledger timestamp is strictly greater than
`expires_at`; the exact expiry timestamp remains valid. Sweeping closes each
expired offer, removes its active and reverse index entries, decrements the
active counter, and attempts to return its escrowed credit to its seller.
The existing admin cleanup function uses the same escrow handling.

If the registry rejects a refund, the offer stays closed and retains a
reclaimable escrow marker. `is_escrow_reclaimable(offer_id)` exposes that
state. The original seller can retry with
`reclaim_expired_offer(seller, offer_id, nonce)` after the registry allows the
transfer. A failed retry preserves the escrow and the seller's nonce.
`OfferExpired` events include the caller, offer ID, seller, and reclaimable
status. Maintenance and reclamation remain available during a marketplace
pause; registry transfer restrictions still apply.

## Credit vintage limits

The registry defaults to a maximum vintage age of 15 UTC calendar years,
including on existing registries without a stored setting.
`get_max_vintage_age()` returns the current limit.
`update_max_vintage_age(admin, max_vintage_age: u32, nonce)` requires the
stored administrator's authorization and a fresh registry nonce.

Submission, including session submission, and credit transfers return
`CarbonChainError::VintageExpired` (133) when the current calendar year minus
the vintage year exceeds the limit. A vintage exactly at the limit is valid.
The year calculation accounts for leap years and advances at midnight UTC
on January 1. Existing metadata validation still allows vintages from 1990
through the following year. A zero age limit allows only the current year
and that otherwise valid following year.

Updates affect existing escrow immediately. An expired escrow credit cannot
be sold or refunded through `transfer_credit`; sweeping records it as
reclaimable until registry policy permits a return.

## Minimum order quantities

The existing `create_offer`, `create_offer_with_asset`, and `buy_offer`
signatures remain callable. Creation through those entry points defaults to
`min_purchase_tonnes: None`; `buy_offer` purchases all remaining listed units.
Existing stored offers without the new field decode with no minimum.

`create_offer_with_minimum` accepts the same parameters as
`create_offer_with_asset`, with `min_purchase_tonnes: Option<i128>` before
the nonce. A specified minimum must be positive, a multiple of 100,000, and
no greater than the listed volume, otherwise creation returns `InvalidTonnes`.

`buy_offer_quantity` accepts the same parameters as `buy_offer`, with
`purchase_tonnes: i128` before the nonce. Purchases must fit the available
volume and unit increment. A purchase below the configured minimum returns
`BelowMinimumQuantity` (318). A partial purchase must also leave at least
the minimum, avoiding an unfillable remainder. Setting the minimum equal to
the whole volume requires a full purchase.

Partial purchases split the credit in the registry, retain unsold units in
escrow, and charge the proportional remaining price rounded up to the next
payment unit. A partial order that would consume the entire remaining price
is rejected with `InvalidPrice`. Both purchase paths deliver exactly the
listed quantity; if the backing credit is larger, a full fill returns its
unlisted excess to the seller. Payment, splits, and transfers are atomic.

## Retirement batch event

Each successful `batch_retire` publishes one `RetirementBatchProcessed`
event after all individual records and indexes have been processed:

- Topics: `retirement_batch_processed`, `batch_id: BytesN<32>`, `retiree: Address`.
- Data: `total_tonnes: i128` and `credit_count: u32`, counting only successful items.

The batch ID hashes the contract address, retiree, consumed nonce, and
successful retirement IDs, so separate batches in the same ledger have
distinct IDs. Failed entries are excluded from the totals. An entirely
failed batch emits no summary. Individual events and the existing
`BatchRetired` event retain their schemas for existing consumers.
