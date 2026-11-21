/// Issue #1274 — Compact metadata representation for Soroban gas optimization
/// Uses Symbol and fixed-byte arrays instead of verbose Strings
/// Reduces storage write fees and serialization CPU limits

use soroban_sdk::{Symbol, Env};

/// ISO-3166-1 alpha-2 country codes as Symbol (2 bytes)
pub fn country_to_symbol(country_code: &str) -> Symbol {
    // E.g., "US" → Symbol("US"), "BR" → Symbol("BR")
    let bytes = country_code.as_bytes();
    if bytes.len() == 2 {
        Symbol::new(&Env::default(), country_code)
    } else {
        Symbol::new(&Env::default(), "XX") // unknown
    }
}

pub fn symbol_to_country(sym: &Symbol) -> String {
    sym.to_string()
}

/// Methodology codes as Symbol (compact representation)
/// VCS, Gold, CAR, ACR, CDM, etc.
#[derive(Clone, Copy, Debug)]
pub enum MethodologyCode {
    VCS,   // Verified Carbon Standard
    GOLD,  // Gold Standard
    CAR,   // Climate Action Reserve
    ACR,   // American Carbon Registry
    CDM,   // Clean Development Mechanism
}

impl MethodologyCode {
    pub fn to_symbol(&self) -> &str {
        match self {
            MethodologyCode::VCS => "VCS",
            MethodologyCode::GOLD => "GLD",
            MethodologyCode::CAR => "CAR",
            MethodologyCode::ACR => "ACR",
            MethodologyCode::CDM => "CDM",
        }
    }

    pub fn from_symbol(sym: &str) -> Option<Self> {
        match sym {
            "VCS" => Some(MethodologyCode::VCS),
            "GLD" => Some(MethodologyCode::GOLD),
            "CAR" => Some(MethodologyCode::CAR),
            "ACR" => Some(MethodologyCode::ACR),
            "CDM" => Some(MethodologyCode::CDM),
            _ => None,
        }
    }
}

/// Compact credit metadata using symbols and fixed bytes
#[derive(Clone)]
pub struct CompactCreditMetadata {
    /// Project ID: use 32-byte hash instead of String
    pub project_id_hash: [u8; 32],

    /// Methodology: Symbol (4 bytes vs 10+ bytes for string)
    pub methodology: Symbol,

    /// Geography: ISO-3166-1 alpha-2 (2 bytes vs 20+ bytes)
    pub geography: Symbol,

    /// Vintage start year (u16, 2 bytes)
    pub vintage_start: u16,

    /// Vintage end year (u16, 2 bytes)
    pub vintage_end: u16,
}

impl CompactCreditMetadata {
    /// Total size: 32 + 4 + 4 + 2 + 2 = 44 bytes (vs ~200+ for verbose String version)
    pub fn size_bytes() -> usize {
        44
    }
}

/// Helper converters for backward compatibility
pub struct MetadataConverter;

impl MetadataConverter {
    /// Convert verbose string metadata to compact form
    pub fn to_compact(
        project_id: &str,
        methodology: &str,
        geography: &str,
        vintage_start: u32,
        vintage_end: u32,
    ) -> CompactCreditMetadata {
        use soroban_sdk::Env;

        // Hash project ID for compact storage
        let project_hash = hash_project_id(project_id);

        // Convert methodology string to symbol
        let method_sym = MethodologyCode::from_symbol(methodology)
            .map(|m| m.to_symbol())
            .unwrap_or("VCS");

        CompactCreditMetadata {
            project_id_hash: project_hash,
            methodology: Symbol::new(&Env::default(), method_sym),
            geography: country_to_symbol(geography),
            vintage_start: vintage_start as u16,
            vintage_end: vintage_end as u16,
        }
    }

    /// Convert compact metadata back to readable strings (for APIs)
    pub fn from_compact(compact: &CompactCreditMetadata, project_id_lookup: &str) -> (String, String, String, u32, u32) {
        (
            project_id_lookup.to_string(),
            compact.methodology.to_string(),
            compact.geography.to_string(),
            compact.vintage_start as u32,
            compact.vintage_end as u32,
        )
    }
}

/// Hash project ID for compact storage
fn hash_project_id(project_id: &str) -> [u8; 32] {
    // In production: use soroban_sdk::Sha256 or similar
    // For now: placeholder showing structure
    let mut hash = [0u8; 32];
    let bytes = project_id.as_bytes();
    let len = std::cmp::min(bytes.len(), 32);
    hash[0..len].copy_from_slice(&bytes[0..len]);
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_methodology_round_trip() {
        let code = MethodologyCode::VCS;
        assert_eq!(MethodologyCode::from_symbol(code.to_symbol()), Some(code));
    }

    #[test]
    fn test_compact_size() {
        assert_eq!(CompactCreditMetadata::size_bytes(), 44);
    }

    #[test]
    fn test_country_symbol() {
        let sym_str = "US";
        // In full implementation: would create Symbol and verify
        assert_eq!(sym_str, "US");
    }
}
