use soroban_sdk::contracterror;

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
    InvalidRegistry = 209,
}
