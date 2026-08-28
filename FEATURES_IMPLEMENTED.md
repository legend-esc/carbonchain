# Features Implemented - Issues #84-87

This document summarizes the implementation of four major features for the CarbonChain platform.

## Issue #84: Verifier Reputation Scoring

### Overview
Implemented on-chain tracking of verifier performance to distinguish reliable verifiers from those who approve fraudulent credits.

### Changes
- **New Data Structure**: `VerifierReputation` struct with `approval_count` and `dispute_count` fields
- **Storage**: Added `VerifierReputation(Address)` DataKey variant for persistent storage
- **Functions**:
  - `get_verifier_reputation(verifier: Address) -> VerifierReputation` - View function to query reputation
  - `increment_approval_count(verifier: Address)` - Called on successful credit approval
  - `increment_dispute_count(verifier: Address)` - Called when credit is flagged as disputed

### Implementation Details
- Reputation is stored in persistent storage with TTL management
- Initialized with 0 counts on first access
- Incremented atomically on each approval or dispute
- Accessible via public view function for transparency

### Tests
- `test_verifier_reputation_increments_on_approval` - Verifies approval count increases
- `test_verifier_reputation_increments_on_dispute` - Verifies dispute count increases

---

## Issue #85: Credit Transfer Function

### Overview
Enables OTC (over-the-counter) trades by allowing credits to change ownership outside the marketplace.

### Changes
- **New Field**: Added `owner: Address` field to `CreditMetadata` struct
- **New Function**: `transfer_credit(from: Address, to: Address, credit_id: BytesN<32>, nonce: u64) -> Result<(), CarbonChainError>`
- **New Event**: `credit_transferred(from, to, credit_id)` event emission

### Implementation Details
- Requires authorization from the current owner (`from.require_auth()`)
- Validates ownership before transfer
- Updates owner field in credit metadata
- Emits transfer event for audit trail
- Includes nonce-based replay protection

### Authorization
- Only the current owner can initiate a transfer
- Nonce consumption prevents replay attacks
- Contract pause status is respected

### Tests
- `test_transfer_credit_changes_owner` - Verifies owner field is updated
- `test_transfer_credit_requires_ownership` - Verifies unauthorized transfers fail

---

## Issue #86: Batch Retirement Function

### Overview
Enables efficient retirement of multiple credits in a single transaction, reducing gas costs and improving UX for large portfolio retirements.

### Changes
- **New Function**: `batch_retire(buyer: Address, credit_ids: Vec<BytesN<32>>, tonnes: Vec<i128>, reason: String, registry_id: Address, nonce: u64) -> Result<Vec<BytesN<32>>, RetirementError>`
- **New Error Code**: `InvalidNonce = 115` in RetirementError enum
- **New Error Code**: `NoPendingAdmin = 116` in RetirementError enum

### Implementation Details
- Accepts vectors of credit IDs and corresponding tonnes
- Validates that both vectors have equal length
- Creates individual `RetirementRecord` for each credit
- Calls `mark_retired` on registry for each credit
- Indexes all retirements under buyer's account
- Emits individual `retire` events per credit for full audit trail
- Includes nonce-based replay protection

### Compute Budget Implications
- Linear complexity: O(n) where n = number of credits
- Each credit requires:
  - One storage write for retirement record
  - One cross-contract call to registry
  - One event emission
- Recommended batch size: 5-10 credits per transaction to stay within compute budget

### Tests
- `test_batch_retire_multiple_credits` - Verifies batch of 5 credits are retired
- `test_batch_retire_indexes_all_retirements` - Verifies all retirements are indexed

---

## Issue #87: Credit Splitting Function

### Overview
Allows large credits to be split into smaller units without going through the marketplace, enabling flexible credit management.

### Changes
- **New Function**: `split_credit(caller: Address, credit_id: BytesN<32>, split_tonnes: i128, nonce: u64) -> Result<(BytesN<32>, BytesN<32>), CarbonChainError>`
- **New Error Code**: `InvalidSplit = 115` in CarbonChainError enum
- **New Event**: `credit_split(original_id, child1_id, child2_id)` event emission

### Implementation Details
- Requires ownership of the credit
- Validates split amount: must be > 0 and < total tonnes
- Creates two child credits with:
  - Same metadata as original (project_id, methodology, geography, etc.)
  - Split tonnes distributed between children
  - Original owner as owner of both children
  - Active status (not retired)
- Retires the original credit to prevent double-spending
- Generates deterministic child credit IDs using SHA256 hash
- Adds both children to project's credit index

### Metadata Preservation
- All metadata fields are preserved in child credits:
  - `project_id` - Same as original
  - `issuer` - Same as original
  - `vintage_year` - Same as original
  - `methodology` - Same as original
  - `geography` - Same as original
  - `ipfs_hash` - Same as original
  - `issued_at` - Same as original
- Only `tonnes` and `owner` are modified

### Tests
- `test_split_credit_creates_two_children` - Verifies two children are created with correct tonnes
- `test_split_credit_retires_original` - Verifies original credit is retired
- `test_split_credit_invalid_split_fails` - Verifies invalid splits are rejected

---

## Cross-Cutting Changes

### Types Updates
- Added `owner: Address` field to `CreditMetadata`
- Added `VerifierReputation` struct
- Extended `DataKey` enum with new variants:
  - `Nonce(Address)` - For nonce management
  - `PendingAdmin` - For admin transfer
  - `VerifierReputation(Address)` - For reputation storage

### Storage Module Enhancements
- Added `get_nonce(addr: Address) -> u64`
- Added `consume_nonce(addr: Address, expected: u64) -> bool`
- Added `get_verifier_reputation(verifier: Address) -> VerifierReputation`
- Added `set_verifier_reputation(verifier: Address, rep: VerifierReputation)`
- Added `increment_approval_count(verifier: Address)`
- Added `increment_dispute_count(verifier: Address)`

### Error Codes
- `InvalidNonce = 113` - Nonce validation failed
- `NoPendingAdmin = 114` - No pending admin to accept
- `InvalidSplit = 115` - Invalid split parameters
- `InvalidNonce = 115` (Retirement) - Nonce validation failed in retirement
- `NoPendingAdmin = 116` (Retirement) - No pending admin in retirement

### Events
- `credit_transferred(from, to, credit_id)` - Emitted on transfer
- `credit_split(original_id, child1_id, child2_id)` - Emitted on split
- `batch_retired(buyer, count)` - Emitted on batch retirement

---

## Backward Compatibility

All existing contract methods remain unchanged. The new features are:
- **Additive**: New functions don't modify existing behavior
- **Optional**: Existing workflows continue to work without changes
- **Non-breaking**: All existing tests pass without modification

The `owner` field addition to `CreditMetadata` is backward compatible as it's initialized to the issuer on credit creation.

---

## Security Considerations

### Authorization
- All state-mutating operations require caller authorization via `require_auth()`
- Ownership checks prevent unauthorized transfers and splits
- Verifier reputation is read-only for non-verifiers

### Replay Protection
- All operations use nonce-based replay protection
- Nonces are consumed atomically with state changes
- Nonce storage includes TTL management

### Audit Trail
- All operations emit events for full traceability
- Batch operations emit individual events per item
- Retirement records are immutable

---

## Testing

All new features include comprehensive test coverage:
- Unit tests for each function
- Authorization and validation tests
- Edge case tests (invalid splits, unauthorized transfers, etc.)
- Integration tests with cross-contract calls

Run tests with:
```bash
cd contracts && cargo test
```

---

## API Integration

The NestJS API layer should be updated to expose these new functions:
- `POST /api/v1/credits/:id/transfer` - Transfer credit
- `POST /api/v1/credits/:id/split` - Split credit
- `POST /api/v1/retirement/batch` - Batch retire credits
- `GET /api/v1/verifiers/:address/reputation` - Get verifier reputation

---

## Future Enhancements

Potential improvements for future iterations:
1. Fractional split support (split into more than 2 pieces)
2. Conditional transfers (escrow-based transfers)
3. Reputation-based access control (restrict operations by verifier score)
4. Batch transfer support
5. Credit merging (combine multiple credits)
