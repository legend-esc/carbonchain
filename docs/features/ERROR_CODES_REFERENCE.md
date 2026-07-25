# Error Codes Reference

Stable, contract-versioned error codes for all CarbonChain Soroban smart contracts.
Each contract owns a distinct numeric range so errors can be unambiguously attributed
to the contract that produced them — even when cross-contract calls are involved.

> **ABI stability guarantee**: error codes within an active contract version will
> not change. When a contract is upgraded, any codes that are removed or renumbered
> are documented in the migration notes section below.

---

## Ranges at a glance

| Contract | Range | Variants |
|---|---|---|
| `credit_registry` | 100 – 125 | 26 |
| `retirement` | 110 – 118 | 9 |
| `marketplace` | 115 – 125 | 9 |
| `mrv_oracle` | 400 – 410 | 11 |

> **Note**: The `retirement` and `marketplace` ranges overlap with the tail of
> the `credit_registry` range because those contracts were defined before the
> current convention was adopted. The ranges will be normalised in a future
> breaking upgrade (see migration notes).

---

## `credit_registry` — 100–125

Defined in `contracts/credit_registry/src/errors.rs` as `CarbonChainError`.

| Code | Variant | Meaning |
|---|---|---|
| 100 | `NotInitialized` | Contract has not been initialised via `initialize()`. |
| 101 | `AlreadyInitialized` | `initialize()` was called more than once. |
| 102 | `Unauthorized` | Caller is not the admin or does not hold the required role. |
| 103 | `InvalidMetadata` | One or more metadata fields failed validation. |
| 104 | `CreditNotFound` | No credit with the supplied ID exists. |
| 105 | `InvalidStatusTransition` | The requested status change is not allowed from the current status. |
| 106 | `VerifierAlreadyExists` | The verifier address is already registered. |
| 107 | `VerifierNotFound` | No verifier with the supplied address exists. |
| 108 | `InsufficientBalance` | Caller's token balance is too low for the requested operation. |
| 109 | `Overflow` | An arithmetic operation overflowed the i128 range. |
| 110 | `InvalidTonnes` | `tonnes` is not a positive multiple of `MIN_CREDIT_UNIT` (100,000). |
| 111 | `InvalidAdmin` | Supplied admin address is invalid or does not match storage. |
| 112 | `ContractPaused` | All state-mutating operations are suspended. |
| 113 | `IssuerNotAllowed` | Caller is not a registered issuer. |
| 114 | `InvalidMethodology` | The methodology string is not on the approved list. |
| 115 | `InvalidNonce` | Replay-protection nonce mismatch. |
| 116 | `NoPendingAdmin` | `accept_admin` was called but no transfer has been proposed. |
| 117 | `InvalidSplit` | Fractional split percentages do not sum to 100. |
| 118 | `InvalidDisputeStatus` | A dispute operation was attempted on a non-disputed credit. |
| 119 | `VerifierHasPendingCredits` | Cannot remove a verifier who still has pending credits awaiting approval. |
| 120 | `ProjectNotFound` | No project with the supplied ID exists. |
| 121 | `DuplicateCredit` | A credit with the same project/vintage/methodology already exists. |
| 122 | `ProjectAlreadyExists` | The project ID is already registered. |
| 123 | `SessionNotFound` | The referenced audit session does not exist. |
| 124 | `InvalidApprovalThreshold` | `required_approvals` is zero or exceeds the registered verifier count. |
| 125 | `AlreadyApproved` | The verifier has already approved this credit. |

---

## `retirement` — 110–118

Defined in `contracts/retirement/src/errors.rs` as `RetirementError`.

| Code | Variant | Meaning |
|---|---|---|
| 110 | `CreditNotActive` | The referenced credit is not in `Active` status. |
| 111 | `AlreadyInitialized` | `initialize()` was called more than once. |
| 112 | `NotInitialized` | Contract has not been initialised. |
| 113 | `Unauthorized` | Caller is not the admin. |
| 114 | `ContractPaused` | All state-mutating operations are suspended. |
| 115 | `InvalidNonce` | Replay-protection nonce mismatch. |
| 116 | `NoPendingAdmin` | `accept_admin` called with no pending transfer. |
| 117 | `InvalidTonnes` | Retirement `tonnes` is invalid (zero, negative, or not a unit multiple). |
| 118 | `InvalidInput` | Generic input validation failure. |

---

## `marketplace` — 115–125

Defined inline in `contracts/marketplace/src/lib.rs` as `MarketplaceError`.

| Code | Variant | Meaning |
|---|---|---|
| 115 | `OfferNotFound` | No offer with the supplied ID exists. |
| 116 | `Unauthorized` | Caller is not the offer owner or admin. |
| 117 | `InvalidPrice` | Offer price is zero or negative. |
| 118 | `AlreadyClosed` | The offer has already been closed or filled. |
| 119 | `CreditNotActive` | The offered credit is not active. |
| 120 | `NotInitialized` | Marketplace contract has not been initialised. |
| 121 | `ContractPaused` | All state-mutating operations are suspended. |
| 125 | `InvalidTonnes` | Offer `tonnes` is invalid. |

---

## `mrv_oracle` — 400–410

Defined in `contracts/mrv_oracle/src/lib.rs` as `OracleError`.

| Code | Variant | Meaning |
|---|---|---|
| 400 | `NotInitialized` | Contract has not been initialised via `initialize()`. |
| 401 | `Unauthorized` | Caller is not the admin or is not a registered oracle address. |
| 402 | `AlreadyInitialized` | `initialize()` was called more than once. |
| 403 | `Overflow` | Anomaly calculation overflowed (extremely large `tonnes` value). |
| 404 | `ContractPaused` | All state-mutating operations are suspended. |
| 405 | `ProjectNotFound` | No data has ever been submitted for the requested project ID. |
| 406 | `InvalidNonce` | Replay-protection nonce mismatch. |
| 407 | `InvalidProject` | Project exists in registry but has no associated credits. |
| 408 | `InvalidTimestamp` | `timestamp` is later than the current ledger timestamp. |
| 409 | `NoPendingAdmin` | `accept_admin` was called but no transfer has been proposed. |
| 410 | `InvalidReading` | `tonnes` is negative. |

### API HTTP mapping

The NestJS `OracleService` maps these codes to HTTP responses as follows:

| Oracle code | HTTP status | Reason |
|---|---|---|
| 400 | 503 Service Unavailable | Contract not yet deployed/initialised |
| 401 | 401 Unauthorized | Caller not authorised |
| 402 | 400 Bad Request | Already initialised |
| 403 | 400 Bad Request | Arithmetic overflow |
| 404 | 503 Service Unavailable | Contract is paused |
| 405 | 404 Not Found | Project not found |
| 406 | 400 Bad Request | Invalid nonce |
| 407 | 400 Bad Request | Invalid project |
| 408 | 400 Bad Request | Future timestamp |
| 409 | 400 Bad Request | No pending admin |
| 410 | 400 Bad Request | Negative tonnes |

---

## Migration notes

### v1 → v2 (oracle error code renumbering)

**Affected contract**: `mrv_oracle`

**Change**: `OracleError` codes were renumbered from the conflicting 119–129 range
to the canonical 400–410 range.

**Reason**: The old codes 119–129 overlapped with `credit_registry` error codes
(119 = `VerifierHasPendingCredits`, 120 = `ProjectNotFound`, etc.), causing
cross-contract error decoding in the API to misattribute oracle errors as registry
errors.

**Migration path**:
- Deploy the updated `mrv_oracle` WASM using `stellar contract upload` + `stellar contract
  install`.
- Update any off-chain indexers or monitoring tools that inspect raw contract error
  codes: map the old 119–129 values to the new 400–410 equivalents.
- Transaction history produced before the upgrade will contain the old codes;
  these cannot be retroactively changed on-chain.

**Old → new mapping**:

| Old code | New code | Variant |
|---|---|---|
| 119 | 400 | `NotInitialized` |
| 120 | 401 | `Unauthorized` |
| 121 | 402 | `AlreadyInitialized` |
| 122 | 403 | `Overflow` |
| 123 | 404 | `ContractPaused` |
| 124 | 405 | `ProjectNotFound` |
| 125 | 406 | `InvalidNonce` |
| 126 | 407 | `InvalidProject` |
| 127 | 408 | `InvalidTimestamp` |
| 128 | 409 | `NoPendingAdmin` |
| 129 | 410 | `InvalidReading` |
