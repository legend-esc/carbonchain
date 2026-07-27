use soroban_sdk::{contracttype, Address, BytesN, String, Vec};

/// Minimum TTL in ledgers (~1 year at 5s/ledger).
pub const MIN_TTL: u32 = 6_307_200;
/// Threshold below which TTL is extended (half of MIN_TTL).
pub const TTL_THRESHOLD: u32 = MIN_TTL / 2;

/// Cross-contract type stubs for the credit registry's types.
/// These must match `carbonchain_credit_registry::types` exactly so that
/// `env.invoke_contract` can deserialize the return value.
#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum CreditStatus {
    Pending = 0,
    Active = 1,
    Retired = 2,
    Flagged = 3,
    Disputed = 4,
    Expired = 5,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct CreditMetadata {
    pub project_id: String,
    pub issuer: Address,
    pub owner: Address,
    pub vintage_year: u32,
    pub methodology: String,
    pub geography: String,
    pub tonnes: i128,
    pub ipfs_hash: String,
    pub status: CreditStatus,
    pub issued_at: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RetirementRecord {
    pub credit_id: BytesN<32>,
    pub buyer: Address,
    /// Carbon volume retired in scaled units. 1 tonne = 1_000_000 units.
    pub tonnes_retired: i128,
    pub reason: String,
    pub retired_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Retirement(BytesN<32>),
    AccountRetirements(Address),
    Admin,
    Paused,
    Nonce(Address),
    PendingAdmin,
}

/// A single failed retirement entry within a partial-success batch.
#[derive(Clone, Debug)]
#[contracttype]
pub struct BatchRetireFailure {
    /// The credit ID that could not be retired.
    pub credit_id: BytesN<32>,
    /// The error code that caused the failure.
    pub error_code: u32,
}

/// Result returned by `batch_retire` in partial-success mode.
///
/// Successful credits are retired and their retirement IDs are in `succeeded`.
/// Invalid credits are skipped and their IDs (plus error codes) are in `failed`.
/// An empty `succeeded` list is never returned — the call fails with `InvalidInput`
/// if no credits in the batch are valid.
#[derive(Clone, Debug)]
#[contracttype]
pub struct BatchRetireResult {
    /// Retirement IDs for credits that were successfully retired.
    pub succeeded: Vec<BytesN<32>>,
    /// Credits that could not be retired, with the reason code.
    pub failed: Vec<BatchRetireFailure>,
}
