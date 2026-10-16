use soroban_sdk::contracterror;

/// Stable error codes for the CarbonChain retirement contract.
///
/// All error codes occupy the 200–210 range to avoid collision with the
/// credit registry (100–130) and marketplace (300+) contracts.
///
/// Codes are intentionally stable — do not renumber existing variants.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RetirementError {
    CreditNotActive = 200,
    AlreadyInitialized = 201,
    NotInitialized = 202,
    Unauthorized = 203,
    ContractPaused = 204,
    InvalidNonce = 205,
    NoPendingAdmin = 206,
    InvalidTonnes = 207,
    InvalidInput = 208,
    /// Downgrade guard: installing an older WASM version is not allowed.
    DowngradeNotAllowed = 209,
    /// A retirement record with the given ID does not exist in storage.
    RecordNotFound = 210,
}
