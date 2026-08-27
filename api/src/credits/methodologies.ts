export const VALID_METHODOLOGIES: readonly string[] = [
  'REDD+',
  'VCS',
  'Gold Standard',
  'CDM',
  'Plan Vivo',
];

const CUSTOM_METHODOLOGY_PATTERN = /^Custom-[a-zA-Z0-9][a-zA-Z0-9\-_\s]{0,42}$/;

export function isValidMethodology(methodology: unknown): boolean {
  if (typeof methodology !== 'string') return false;
  return (
    VALID_METHODOLOGIES.includes(methodology) ||
    CUSTOM_METHODOLOGY_PATTERN.test(methodology)
  );
}

export function validateMethodology(methodology: unknown): string | undefined {
  if (typeof methodology !== 'string' || methodology.trim() === '') {
    return 'Methodology must be a non-empty string';
  }
  if (methodology.length > 50) {
    return 'Methodology must be 50 characters or less';
  }
  if (!isValidMethodology(methodology)) {
    return 'Methodology must be a supported value or start with Custom-';
  }
  return undefined;
}
