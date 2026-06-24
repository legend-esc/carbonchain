use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RetirementError {
    CreditNotActive    = 110,
    AlreadyInitialized = 111,
    NotInitialized     = 112,
    Unauthorized       = 113,
    ContractPaused     = 114,
    InvalidNonce       = 115,
    NoPendingAdmin     = 116,
}
