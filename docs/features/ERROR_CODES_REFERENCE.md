# Error Codes Reference

All CarbonChain smart contracts use stable numeric error codes. These codes are stable across contract upgrades and safe to use in API clients and monitoring rules.

## Credit Registry (100–132)

| Code | Name | Description | Triggering Functions |
|------|------|-------------|---------------------|
| 100 | `NotInitialized` | Contract has not been initialised | `pause`, `unpause`, `register_verifier`, `remove_verifier`, `slash_verifier`, `register_issuer`, `remove_issuer`, `register_methodology`, `submit_credit`, `resolve_flag`, `mark_retired`, `propose_admin`, `accept_admin`, `cancel_admin_transfer`, `update_retirement_contract`, `configure_verifier_services`, `add_verifier_service`, `remove_verifier_service`, `expire_credit`, `resolve_dispute`, `upgrade`, `get_audit_log` |
| 101 | `AlreadyInitialized` | Contract has already been initialised | `initialize` |
| 102 | `Unauthorized` | Caller is not authorised for this operation | `pause`, `unpause`, `register_verifier`, `remove_verifier`, `slash_verifier`, `register_issuer`, `remove_issuer`, `approve_and_mint`, `flag_credit`, `resolve_flag`, `transfer_credit`, `split_credit`, `merge_credits`, `propose_admin`, `accept_admin`, `cancel_admin_transfer`, `expire_credit`, `resolve_dispute`, `upgrade`, `get_audit_log` |
| 103 | `InvalidMetadata` | Credit metadata is missing or malformed | `submit_credit`, `register_methodology`, `resolve_dispute`, `merge_credits`, `upgrade` |
| 104 | `CreditNotFound` | Credit ID does not exist | `approve_and_mint`, `flag_credit`, `resolve_flag`, `mark_retired`, `transfer_credit`, `split_credit`, `merge_credits`, `get_credit`, `get_audit_log`, `expire_credit`, `resolve_dispute`, `dispute_credit` |
| 105 | `InvalidStatusTransition` | Requested status change is not allowed | `approve_and_mint`, `flag_credit`, `mark_retired`, `transfer_credit`, `split_credit`, `merge_credits`, `expire_credit`, `dispute_credit` |
| 106 | `VerifierAlreadyExists` | Verifier address is already registered | `register_verifier` |
| 107 | `VerifierNotFound` | Verifier address is not registered | `remove_verifier`, `approve_and_mint`, `flag_credit`, `resolve_flag`, `configure_verifier_services`, `add_verifier_service`, `remove_verifier_service` |
| 108 | `InsufficientBalance` | Account has insufficient token balance | `transfer_credit` |
| 109 | `Overflow` | Arithmetic overflow in calculation | `merge_credits` |
| 110 | `InvalidTonnes` | `tonnes` is zero, negative, not a multiple of 100,000, or out of bounds | `submit_credit` |
| 111 | `InvalidAdmin` | Supplied admin address is not the stored admin | Admin-authorised functions |
| 112 | `ContractPaused` | Contract is paused; state-mutating ops are blocked | `deposit_stake`, `submit_credit`, `approve_and_mint`, `flag_credit`, `resolve_flag`, `mark_retired`, `transfer_credit`, `split_credit`, `merge_credits`, `configure_verifier_services`, `add_verifier_service`, `remove_verifier_service` |
| 113 | `IssuerNotAllowed` | Issuer is not on the approved list | `submit_credit`, `register_issuer` |
| 114 | `InvalidMethodology` | Methodology already exists or is malformed | `register_methodology` |
| 115 | `InvalidNonce` | Replay-protection nonce does not match expected value | `register_verifier`, `remove_verifier`, `deposit_stake`, `withdraw_stake`, `slash_verifier`, `set_min_stake`, `set_stake_token`, `register_issuer`, `remove_issuer`, `register_methodology`, `submit_credit`, `approve_and_mint`, `flag_credit`, `resolve_flag`, `transfer_credit`, `split_credit`, `merge_credits`, `propose_admin`, `update_retirement_contract`, `configure_verifier_services`, `add_verifier_service`, `remove_verifier_service`, `upgrade` |
| 116 | `NoPendingAdmin` | No admin transfer is pending | `accept_admin`, `cancel_admin_transfer` |
| 117 | `InvalidSplit` | Fractional-credit split parameters are invalid | `split_credit` |
| 118 | `InvalidDisputeStatus` | Cannot dispute or resolve a credit in its current state | `resolve_flag`, `resolve_dispute` |
| 119 | `VerifierHasPendingCredits` | Cannot remove a verifier with pending credits | `remove_verifier` |
| 120 | `ProjectNotFound` | Project ID does not exist | `submit_credit`, `get_project` |
| 121 | `DuplicateCredit` | A credit with this ID already exists | `submit_credit` |
| 122 | `ProjectAlreadyExists` | A project with this ID already exists | `register_project` |
| 123 | `SessionNotFound` | Session ID does not exist | `submit_credit_with_session`, `get_session_operation_count`, `get_audit_log` |
| 124 | `InvalidApprovalThreshold` | `required_approvals` is 0 or exceeds verifier count | `initialize`, `upgrade` |
| 125 | `AlreadyApproved` | Verifier has already approved this credit | `approve_and_mint` |
| 126 | `NoRetirementContract` | No retirement contract has been registered | `mark_retired` |
| 127 | `InsufficientStake` | Verifier's locked stake is below the required minimum | `register_verifier`, `slash_verifier` |
| 128 | `InvalidStakeAmount` | Stake deposit/slash amount is zero or negative | `deposit_stake`, `set_min_stake` |
| 129 | `NoUnbondingRequest` | No pending unbonding request for the verifier | `withdraw_stake` |
| 130 | `UnbondingNotReady` | Withdrawing stake before the 30-day unbonding period has elapsed | `withdraw_stake` |
| 131 | `InvalidStakeToken` | Supplied `token_id` does not match the approved/deposited token | `deposit_stake`, `withdraw_stake` |
| 132 | `StakeTransferFailed` | Token transfer failed during `deposit_stake` or `withdraw_stake` | `deposit_stake`, `withdraw_stake` |

## Retirement (200–210)

| Code | Name | Description | Triggering Functions |
|------|------|-------------|---------------------|
| 200 | `CreditNotActive` | Credit is not in `Active` status when retirement is attempted | `retire`, `batch_retire` |
| 201 | `AlreadyInitialized` | Contract has already been initialized | `initialize` |
| 202 | `NotInitialized` | Contract has not been initialized | `pause`, `unpause`, `upgrade`, `propose_admin`, `set_certificate_hash` |
| 203 | `Unauthorized` | Caller is not the credit owner or admin | `retire`, `batch_retire`, `pause`, `unpause`, `upgrade`, `propose_admin`, `set_certificate_hash` |
| 204 | `ContractPaused` | Contract is paused; state-mutating operations are blocked | `retire`, `batch_retire` |
| 205 | `InvalidNonce` | Replay-protection nonce does not match expected value | `retire`, `batch_retire`, `upgrade`, `set_certificate_hash` |
| 206 | `NoPendingAdmin` | No admin transfer is currently pending | `accept_admin` |
| 207 | `InvalidTonnes` | `tonnes` is zero, negative, or not a multiple of 100,000 | `retire`, `batch_retire` |
| 208 | `InvalidInput` | Input vectors have mismatched lengths, or batch exceeds `MAX_BATCH_SIZE` (20) | `batch_retire` |
| 209 | `InvalidRegistry` | `registry_id` does not match the trusted credit registry | `retire`, `batch_retire` |
| 210 | `RecordNotFound` | A retirement record with the given ID does not exist in storage | `set_certificate_hash` |

## Marketplace (300–316)

| Code | Name | Description | Triggering Functions |
|------|------|-------------|---------------------|
| 300 | `OfferNotFound` | Offer ID does not exist | `get_offer`, `cancel_offer` |
| 301 | `Unauthorized` | Caller is not the offer owner or admin | `pause`, `unpause`, `create_offer`, `cancel_offer`, `upgrade`, `update_min_price` |
| 302 | `InvalidPrice` | Offer price is zero, negative, or below the minimum | `create_offer`, `update_offer_price` |
| 303 | `InvalidTonnes` | `tonnes` is zero, negative, or not a multiple of 100,000 | `create_offer` |
| 304 | `AlreadyClosed` | Offer has already been closed or filled | `cancel_offer`, `update_offer_price`, `buy_offer` |
| 305 | `CreditNotActive` | Credit linked to the offer is not active | `create_offer` |
| 306 | `NotInitialized` | Contract has not been initialized | `pause`, `unpause`, `add_allowed_token`, `remove_allowed_token`, `upgrade`, `update_min_price` |
| 307 | `ContractPaused` | Contract is paused | `create_offer`, `cancel_offer`, `buy_offer`, `update_offer_price` |
| 308 | `InvalidNonce` | Replay-protection nonce mismatch | `create_offer`, `add_allowed_token`, `remove_allowed_token`, `cancel_offer`, `buy_offer`, `update_offer_price`, `upgrade` |
| 309 | `OfferExpired` | Offer has passed its expiry timestamp | `get_offer`, `update_offer_price`, `buy_offer` |
| 310 | `Overflow` | Arithmetic overflow detected | `create_offer` (via `next_id`), `buy_offer` |
| 311 | `AlreadyInitialized` | Contract has already been initialized | `initialize` |
| 312 | `InsufficientFunds` | Buyer does not hold enough of the payment asset | `buy_offer` |
| 313 | `EscrowFailed` | Escrow transfer succeeded but offer record failed to persist | `create_offer` |
| 314 | `CreditNotFound` | No credit exists for the given credit ID in the registry | `create_offer`, `cancel_offer` |
| 315 | `InvalidRegistry` | The `registry_id` does not match the trusted credit registry | `create_offer`, `cancel_offer`, `buy_offer` |
| 316 | `InvalidToken` | The `token_id` does not match the allowed payment token | `create_offer_with_asset`, `buy_offer` |

## MRV Oracle (400–412)

| Code | Name | Description | Triggering Functions |
|------|------|-------------|---------------------|
| 400 | `NotInitialized` | Contract has not been initialised | `pause`, `unpause`, `register_oracle`, `set_anomaly_threshold`, `set_project_anomaly_threshold`, `set_trusted_registry`, `upgrade`, `propose_admin` |
| 401 | `Unauthorized` | Caller is not the admin or a registered oracle | `pause`, `unpause`, `register_oracle`, `set_anomaly_threshold`, `set_project_anomaly_threshold`, `set_trusted_registry`, `upgrade`, `propose_admin`, `update_mrv_data`, `accept_admin` |
| 402 | `AlreadyInitialized` | Contract has already been initialised | `initialize` |
| 403 | `Overflow` | Arithmetic overflow in tonnage/anomaly calculation | `update_mrv_data` (via `detect_anomaly`) |
| 404 | `ContractPaused` | Contract is paused | `update_mrv_data` |
| 405 | `ProjectNotFound` | Project ID has no MRV history | `get_latest` |
| 406 | `InvalidNonce` | Replay-protection nonce mismatch | `register_oracle`, `set_anomaly_threshold`, `set_project_anomaly_threshold`, `set_trusted_registry`, `upgrade`, `update_mrv_data` |
| 407 | `InvalidProject` | Project ID has no credits in the registry | `update_mrv_data` |
| 408 | `InvalidTimestamp` | Timestamp is in the future or outside the allowed skew window | `update_mrv_data` |
| 409 | `NoPendingAdmin` | No pending admin transfer | `accept_admin` |
| 410 | `InvalidReading` | MRV reading value is zero or negative | `update_mrv_data` |
| 411 | `InvalidThreshold` | Threshold basis points are not in the valid range (1–10000) | `set_anomaly_threshold`, `set_project_anomaly_threshold` |
| 412 | `InvalidRegistry` | `registry_id` does not match the trusted credit registry | `update_mrv_data` |

## Notes

- Error codes are **stable** — they will not change across contract upgrades.
- All `tonnes` values use scaled units: **1 tonne = 1,000,000 units**, minimum unit = 100,000 (0.1 tonne).
- `InvalidInput` (retirement code 208) is also returned when a `batch_retire` call exceeds `MAX_BATCH_SIZE = 20`.
- Code ranges are non-overlapping: credit_registry (100–132), retirement (200–210), marketplace (300–316), mrv_oracle (400–412). This prevents collisions when the NestJS API surfaces contract errors to clients.
- Each contract's error enum is the source of truth: `contracts/credit_registry/src/errors.rs`, `contracts/retirement/src/errors.rs`, `contracts/marketplace/src/lib.rs`, `contracts/mrv_oracle/src/lib.rs`.
