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

## Retirement (110–118)

| Code | Name | Description |
|------|------|-------------|
| 110 | `CreditNotActive` | Credit is not in `Active` status |
| 111 | `AlreadyInitialized` | Contract has already been initialized |
| 112 | `NotInitialized` | Contract has not been initialized |
| 113 | `Unauthorized` | Caller is not the credit owner or admin |
| 114 | `ContractPaused` | Contract is paused |
| 115 | `InvalidNonce` | Replay-protection nonce mismatch |
| 116 | `NoPendingAdmin` | No pending admin transfer |
| 117 | `InvalidTonnes` | `tonnes` is zero or negative |
| 118 | `InvalidInput` | Input vectors have mismatched lengths or batch exceeds `MAX_BATCH_SIZE` (20) |

## Marketplace (115–125)

| Code | Name | Description |
|------|------|-------------|
| 115 | `OfferNotFound` | Offer ID does not exist |
| 116 | `Unauthorized` | Caller is not the offer owner or admin |
| 117 | `InvalidPrice` | Offer price is zero or negative |
| 118 | `AlreadyClosed` | Offer has already been closed or filled |
| 119 | `CreditNotActive` | Credit linked to the offer is not active |
| 120 | `NotInitialized` | Contract has not been initialized |
| 121 | `ContractPaused` | Contract is paused |
| 125 | `InvalidTonnes` | `tonnes` is zero or negative |

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
- `InvalidInput` (retirement code 118) is also returned when a `batch_retire` call exceeds `MAX_BATCH_SIZE = 20`.
