# Error Codes Reference

All CarbonChain smart contracts use stable numeric error codes. These codes are stable across contract upgrades and safe to use in API clients and monitoring rules.

## Credit Registry (100–125)

| Code | Name | Description |
|------|------|-------------|
| 100 | `NotInitialized` | Contract has not been initialized |
| 101 | `AlreadyInitialized` | Contract has already been initialized |
| 102 | `Unauthorized` | Caller is not authorized for this operation |
| 103 | `InvalidMetadata` | Credit metadata is missing or malformed |
| 104 | `CreditNotFound` | Credit ID does not exist |
| 105 | `InvalidStatusTransition` | Requested status change is not allowed |
| 106 | `VerifierAlreadyExists` | Verifier address is already registered |
| 107 | `VerifierNotFound` | Verifier address is not registered |
| 108 | `InsufficientBalance` | Account does not hold enough credits |
| 109 | `Overflow` | Arithmetic overflow in credit calculation |
| 110 | `InvalidTonnes` | `tonnes` is zero, negative, or not a multiple of 100,000 |
| 111 | `InvalidAdmin` | Proposed admin address is invalid |
| 112 | `ContractPaused` | Contract is paused; state-mutating ops are blocked |
| 113 | `IssuerNotAllowed` | Issuer is not on the approved list |
| 114 | `InvalidMethodology` | Methodology string is not registered |
| 115 | `InvalidNonce` | Replay-protection nonce does not match expected value |
| 116 | `NoPendingAdmin` | No admin transfer is pending |
| 117 | `InvalidSplit` | Fractional-credit split parameters are invalid |
| 118 | `InvalidDisputeStatus` | Cannot dispute a credit in its current state |
| 119 | `VerifierHasPendingCredits` | Cannot remove a verifier with pending credits |
| 120 | `ProjectNotFound` | Project ID does not exist |
| 121 | `DuplicateCredit` | A credit with this ID already exists |
| 122 | `ProjectAlreadyExists` | A project with this ID already exists |
| 123 | `SessionNotFound` | Session ID does not exist |
| 124 | `InvalidApprovalThreshold` | `required_approvals` is 0 or exceeds verifier count |
| 125 | `AlreadyApproved` | Verifier has already approved this credit |

## Retirement (200–210)

| Code | Name | Description | Triggering Functions |
|------|------|-------------|----------------------|
| 200 | `CreditNotActive` | Credit is not in `Active` status when retirement is attempted | `retire`, `batch_retire` |
| 201 | `AlreadyInitialized` | Contract has already been initialized | `initialize` |
| 202 | `NotInitialized` | Contract has not been initialized | `pause`, `unpause`, `upgrade`, `propose_admin`, `set_certificate_hash` |
| 203 | `Unauthorized` | Caller is not the credit owner or admin | `retire`, `batch_retire`, `pause`, `unpause`, `upgrade`, `propose_admin`, `set_certificate_hash` |
| 204 | `ContractPaused` | Contract is paused; state-mutating operations are blocked | `retire`, `batch_retire` |
| 205 | `InvalidNonce` | Replay-protection nonce does not match expected value | `retire`, `batch_retire`, `upgrade`, `set_certificate_hash` |
| 206 | `NoPendingAdmin` | No admin transfer is currently pending | `accept_admin` |
| 207 | `InvalidTonnes` | `tonnes` is zero, negative, or not a multiple of 100,000 | `retire`, `batch_retire` |
| 208 | `InvalidInput` | Input vectors have mismatched lengths, or batch exceeds `MAX_BATCH_SIZE` (20) | `batch_retire` |
| 209 | `DowngradeNotAllowed` | Installing an older WASM version is not allowed | `upgrade` |
| 210 | `RecordNotFound` | A retirement record with the given ID does not exist in storage | `set_certificate_hash` |

## Marketplace (115–128)

| Code | Name | Description | Triggering Functions |
|------|------|-------------|----------------------|
| 115 | `OfferNotFound` | Offer ID does not exist | `buy_offer`, `cancel_offer`, `get_offer` |
| 116 | `Unauthorized` | Caller is not the offer owner or admin | `cancel_offer`, `update_offer` |
| 117 | `InvalidPrice` | Offer price is zero, negative, or below minimum | `create_offer`, `create_offer_with_asset` |
| 118 | `AlreadyClosed` | Offer has already been cancelled or filled | `buy_offer`, `cancel_offer` |
| 119 | `CreditNotActive` | Credit linked to the offer is not in `Active` status | `create_offer`, `create_offer_with_asset` |
| 120 | `NotInitialized` | Contract has not been initialized | All state-mutating ops |
| 121 | `ContractPaused` | Contract is paused | All state-mutating ops |
| 122 | `InvalidNonce` | Replay-protection nonce mismatch | `create_offer`, `buy_offer`, `cancel_offer` |
| 123 | `OfferExpired` | Offer's `expires_at` timestamp has passed | `buy_offer` |
| 124 | `Overflow` | Price is zero or negative (corrupt offer state) | `buy_offer` |
| 125 | `InvalidTonnes` | `tonnes` is zero, negative, or not a multiple of 100,000 | `create_offer`, `create_offer_with_asset` |
| 126 | `AlreadyInitialized` | Contract has already been initialized | `initialize` |
| 127 | `InsufficientFunds` | Buyer balance is less than the offer price | `buy_offer` |
| 128 | `EscrowFailed` | Escrow transfer succeeded but offer record failed to persist | `create_offer`, `create_offer_with_asset` |

## MRV Oracle (119–129)

| Code | Name | Description |
|------|------|-------------|
| 119 | `NotInitialized` | Contract has not been initialized |
| 120 | `Unauthorized` | Caller is not a registered oracle |
| 121 | `AlreadyInitialized` | Contract has already been initialized |
| 122 | `Overflow` | Arithmetic overflow in tonnage calculation |
| 123 | `ContractPaused` | Contract is paused |
| 124 | `ProjectNotFound` | Project ID has no MRV history |
| 125 | `InvalidNonce` | Replay-protection nonce mismatch |
| 126 | `InvalidProject` | Project ID is empty or malformed |
| 127 | `InvalidTimestamp` | Timestamp is not greater than the previous reading |
| 128 | `NoPendingAdmin` | No pending admin transfer |
| 129 | `InvalidReading` | MRV reading value is zero or negative |

## Notes

- Error codes are **stable** — they will not change across contract upgrades.
- All `tonnes` values use scaled units: **1 tonne = 1,000,000 units**, minimum unit = 100,000 (0.1 tonne).
- `InvalidInput` (retirement code 208) is also returned when a `batch_retire` call exceeds `MAX_BATCH_SIZE = 20`.
- `RecordNotFound` (retirement code 210) is returned by `set_certificate_hash` when the retirement ID is not found; `CreditNotActive` (200) is returned when the credit being retired is not in `Active` status.
