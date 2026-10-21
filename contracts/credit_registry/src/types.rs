use soroban_sdk::{contracttype, Address, BytesN, String};

/// Unit convention: all `tonnes` fields are stored as fixed-point integers
/// where 1 tonne = 1_000_000 units (0.1 tonne resolution = 100_000 units).
pub const TONNES_SCALE: i128 = 1_000_000;

/// Complete ISO 3166-1 alpha-2 country code list.
///
/// Used to validate the `geography` field of submitted credits. Only these
/// two-character codes are accepted on-chain; any other value is rejected with
/// [`CarbonChainError::InvalidMetadata`].
pub const VALID_ISO_COUNTRY_CODES: &[&str] = &[
  "AF", "AX", "AL", "DZ", "AS", "AD", "AO", "AI", "AQ", "AG",
  "AR", "AM", "AW", "AU", "AT", "AZ", "BS", "BH", "BD", "BB",
  "BY", "BE", "BZ", "BJ", "BM", "BT", "BO", "BQ", "BA", "BW",
  "BV", "BR", "IO", "BN", "BG", "BF", "BI", "CV", "KH", "CM",
  "CA", "KY", "CF", "TD", "CL", "CN", "CX", "CC", "CO", "KM",
  "CG", "CD", "CK", "CR", "CI", "HR", "CU", "CW", "CY", "CZ",
  "DK", "DJ", "DM", "DO", "EC", "EG", "SV", "GQ", "ER", "EE",
  "SZ", "ET", "FK", "FO", "FJ", "FI", "FR", "GF", "PF", "TF",
  "GA", "GM", "GE", "DE", "GH", "GI", "GR", "GL", "GD", "GP",
  "GU", "GT", "GG", "GN", "GW", "GY", "HT", "HM", "VA", "HN",
  "HK", "HU", "IS", "IN", "ID", "IR", "IQ", "IE", "IM", "IL",
  "IT", "JM", "JP", "JE", "JO", "KZ", "KE", "KI", "KP", "KR",
  "KW", "KG", "LA", "LV", "LB", "LS", "LR", "LY", "LI", "LT",
  "LU", "MO", "MG", "MW", "MY", "MV", "ML", "MT", "MH", "MQ",
  "MR", "MU", "YT", "MX", "FM", "MD", "MC", "MN", "ME", "MS",
  "MA", "MZ", "MM", "NA", "NR", "NP", "NL", "NC", "NZ", "NI",
  "NE", "NG", "NU", "NF", "MK", "MP", "NO", "OM", "PK", "PW",
  "PS", "PA", "PG", "PY", "PE", "PH", "PN", "PL", "PT", "PR",
  "QA", "RE", "RO", "RU", "RW", "BL", "SH", "KN", "LC", "MF",
  "PM", "VC", "WS", "SM", "ST", "SA", "SN", "RS", "SC", "SL",
  "SG", "SX", "SK", "SI", "SB", "SO", "ZA", "GS", "SS", "ES",
  "LK", "SD", "SR", "SJ", "SE", "CH", "SY", "TW", "TJ", "TZ",
  "TH", "TL", "TG", "TK", "TO", "TT", "TN", "TR", "TM", "TC",
  "TV", "UG", "UA", "AE", "GB", "US", "UM", "UY", "UZ", "VU",
  "VE", "VN", "VG", "VI", "WF", "EH", "YE", "ZM", "ZW",
];

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

#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum ServiceType {
    CreditApproval = 0,
    MRVReview = 1,
}

/// Resolution outcome for a flagged credit dispute.
///
/// - `Confirmed` — the flag is confirmed; the credit remains `Flagged` (anomaly validated).
/// - `Rejected`  — the flag was a false positive; the credit is restored to `Active`.
#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum DisputeResolution {
    /// The flag is confirmed — credit stays Flagged.
    Confirmed = 0,
    /// The flag was a false positive — credit is restored to Active.
    Rejected = 1,
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
    /// Carbon volume in scaled units. 1 tonne = [`TONNES_SCALE`] (1_000_000).
    pub tonnes: i128,
    pub ipfs_hash: String,
    pub status: CreditStatus,
    pub issued_at: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct VerifierReputation {
    pub approval_count: u64,
    pub dispute_count: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Methodology {
    pub code: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct ProjectMetadata {
    pub owner: Address,
    pub name: String,
    pub description: String,
    pub location: String,
    pub created_at: u64,
}

/// A session for grouping related credit operations.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Session {
    pub initiator: Address,
    pub created_at: u64,
    pub operation_count: u64,
}

/// An audit log entry recording a credit operation within a session.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct AuditLogEntry {
    pub session_id: BytesN<32>,
    pub credit_id: BytesN<32>,
    pub actor: Address,
    pub action: String,
    pub timestamp: u64,
}

/// A pending stake withdrawal created by `remove_verifier`. The stake becomes
/// withdrawable once `unlock_at` (ledger timestamp) has passed — see issue #565.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct UnbondingRequest {
    pub amount: i128,
    pub unlock_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    /// Contract schema version, used by migrate() to run sequential upgrades.
    Version,
    Admin,
    VerifierSet,
    Credit(BytesN<32>),
    ProjectCredits(String),
    CreditByProjectVintage(String, u32),
    Project(String),
    RetirementContract,
    /// Credit ID nonce shared by the old (pre-#681) code path.
    /// Kept for storage-format compatibility; new code uses the namespaced variants below.
    CreditNonce,
    /// #681 — Namespaced nonce for submit_credit to prevent ID collisions with split/merge.
    SubmitCreditNonce,
    /// #681 — Namespaced nonce for split_credit child ID generation.
    SplitCreditNonce,
    /// #681 — Namespaced nonce for merge_credits merged ID generation.
    MergeCreditNonce,
    Paused,
    IssuerSet,
    MethodologySet,
    Nonce(Address),
    /// Per-address sliding-window nonce bitmap for replay protection.
    /// See `consume_nonce` in storage.rs for details.
    NonceBitmap(Address),
    PendingAdmin,
    VerifierReputation(Address),
    /// Tracks how many Pending credits are assigned to a verifier for approval.
    VerifierPendingCount(Address),
    /// Required number of verifier approvals before a credit is minted.
    RequiredApprovals,
    /// Set of verifier addresses that have already approved a given credit.
    CreditApprovals(BytesN<32>),
    /// Session data keyed by session ID.
    Session(BytesN<32>),
    /// Operation count for a session.
    SessionOpCount(BytesN<32>),
    /// Audit log entry keyed by log ID.
    AuditLog(BytesN<32>),
    /// Counter for audit log entries.
    AuditLogCount,
    /// Monotonic counter for session IDs — kept separate from AuditLogCount so
    /// that session IDs and audit-log IDs can never collide. (Issue #671)
    SessionCount,
    /// Dispute evidence keyed by credit ID.
    Dispute(BytesN<32>),
    /// Verifier services keyed by verifier address.
    VerifierServices(Address),
    /// Stable numeric ID assigned to a verifier on registration.
    VerifierId(Address),
    /// Counter for assigning the next verifier ID.
    NextVerifierId,
    /// Bounded owner index: credits owned by `Address`, stored in fixed-size pages.
    CreditsByOwner(Address),
    /// Bounded pending index: pending credits assigned to `Address`, stored in fixed-size pages.
    PendingCreditsByVerifier(Address),
    /// Per-credit snapshot of verifiers assigned at submission time.
    /// Used by remove_verifier to correctly block removal only when
    /// the verifier is specifically assigned to a pending credit.
    CreditVerifiers(BytesN<32>),
    /// Global list of all credit IDs currently in Pending status.
    /// Maintained by submit_credit (add) and approve_and_mint/flag_credit (remove).
    /// Used by remove_verifier to iterate per-credit snapshots efficiently.
    PendingCredits,
    /// Total number of credits ever submitted. Never decremented — used for O(1) credit count.
    TotalCredits,
    /// Stake amount (in the configured stake token's smallest unit) locked by a verifier.
    VerifierStake(Address),
    /// Minimum stake required to register as a verifier. Configurable by the admin.
    MinStake,
    /// Pending unbonding request created when a verifier is removed.
    UnbondingRequest(Address),
    /// Token contract address that was deposited as stake by a specific verifier.
    /// Persisted at deposit_stake time; withdraw_stake must supply the same token.
    VerifierStakeToken(Address),
    /// Admin-configured token contract address that is the only accepted stake token.
    /// deposit_stake validates the caller-supplied token_id against this value.
    ApprovedStakeToken,
}
