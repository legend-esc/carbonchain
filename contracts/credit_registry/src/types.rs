use soroban_sdk::{contracttype, Address, String, BytesN};

/// Unit convention: all `tonnes` fields are stored as fixed-point integers
/// where 1 tonne = 1_000_000 units (0.1 tonne resolution = 100_000 units).
pub const TONNES_SCALE: i128 = 1_000_000;

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

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    VerifierSet,
    Credit(BytesN<32>),
    ProjectCredits(String),
    CreditByProjectVintage(String, u32),
    Project(String),
    RetirementContract,
    CreditNonce,
    Paused,
    IssuerSet,
    MethodologySet,
    Nonce(Address),
    PendingAdmin,
    VerifierReputation(Address),
    /// Tracks how many Pending credits are assigned to a verifier for approval.
    VerifierPendingCount(Address),
    /// Tracks which verifier is assigned to approve a given credit.
    CreditAssignedVerifier(BytesN<32>),
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
    /// Dispute evidence keyed by credit ID.
    Dispute(BytesN<32>),
    /// Verifier services keyed by verifier address.
    VerifierServices(Address),
}
