/**
 * Valid carbon credit methodologies supported by the system.
 * These values must match the registered methodologies in the contract.
 */
export const VALID_METHODOLOGIES = [
  'REDD+',
  'VCS',
  'Gold Standard',
  'CDM',
  'Plan Vivo',
];

/**
 * Check if a methodology string is valid.
 * Supports the predefined list and validates custom methodologies.
 * @param methodology - The methodology code to validate
 * @returns true if the methodology is valid, false otherwise
 */
export function isValidMethodology(methodology: string): boolean {
  if (!methodology || typeof methodology !== 'string') {
    return false;
  }

  // Check if it's one of the predefined methodologies
  if (VALID_METHODOLOGIES.includes(methodology)) {
    return true;
  }

  // Support custom methodologies: must be non-empty and alphanumeric with basic special chars
  // Custom methodologies should start with 'Custom-' or be registered separately
  return /^[a-zA-Z0-9\-_\s]{1,50}$/.test(methodology);
}

/**
 * Validate methodology and return detailed error message if invalid.
 * @param methodology - The methodology code to validate
 * @returns Error message if invalid, undefined if valid
 */
export function validateMethodology(methodology: string): string | undefined {
  if (!methodology || typeof methodology !== 'string') {
    return 'Methodology must be a non-empty string';
  }

  if (methodology.trim() === '') {
    return 'Methodology cannot be empty';
  }

  if (methodology.length > 50) {
    return 'Methodology must be 50 characters or less';
  }

  if (!isValidMethodology(methodology)) {
    return `Invalid methodology: "${methodology}". Must be one of: ${VALID_METHODOLOGIES.join(', ')}, or a valid custom methodology`;
  }

  return undefined;
}
