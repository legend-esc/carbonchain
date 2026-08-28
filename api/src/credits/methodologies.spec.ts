import {
  isValidMethodology,
  validateMethodology,
  VALID_METHODOLOGIES,
} from './methodologies';

describe('Methodologies', () => {
  describe('isValidMethodology', () => {
    it('should accept predefined valid methodologies', () => {
      VALID_METHODOLOGIES.forEach((methodology) => {
        expect(isValidMethodology(methodology)).toBe(true);
      });
    });

    it('should accept valid methodologies', () => {
      const validMethodologies = [
        'REDD+',
        'VCS',
        'Gold Standard',
        'CDM',
        'Plan Vivo',
      ];

      validMethodologies.forEach((methodology) => {
        expect(isValidMethodology(methodology)).toBe(true);
      });
    });

    it('should accept custom valid methodologies', () => {
      const customMethodologies = [
        'Custom-Method',
        'My-Methodology',
        'carbon-offset-2024',
        'Test_Method',
        'FAKE',
        'fake',
        'INVALID_METHOD_NAME',
      ];

      customMethodologies.forEach((methodology) => {
        expect(isValidMethodology(methodology)).toBe(true);
      });
    });

    it('should reject invalid methodologies', () => {
      const invalidMethodologies = [
        '',
        '""',
        'redd+', // wrong case, contains '+'
      ];

      invalidMethodologies.forEach((methodology) => {
        expect(isValidMethodology(methodology)).toBe(false);
      });
    });

    it('should reject non-string values', () => {
      expect(isValidMethodology(null)).toBe(false);
      expect(isValidMethodology(undefined)).toBe(false);
      expect(isValidMethodology(123 as any)).toBe(false);
      expect(isValidMethodology({} as any)).toBe(false);
    });

    it('should reject methodologies exceeding 50 characters', () => {
      const longMethodology = 'a'.repeat(51);
      expect(isValidMethodology(longMethodology)).toBe(false);
    });

    it('should reject methodologies with invalid characters', () => {
      const invalidMethodologies = [
        'Method@Name',
        'Method!Name',
        'Method#Name',
        'Method$Name',
        'Method%Name',
      ];

      invalidMethodologies.forEach((methodology) => {
        expect(isValidMethodology(methodology)).toBe(false);
      });
    });
  });

  describe('validateMethodology', () => {
    it('should return undefined for valid methodologies', () => {
      VALID_METHODOLOGIES.forEach((methodology) => {
        expect(validateMethodology(methodology)).toBeUndefined();
      });
    });

    it('should return error message for empty string', () => {
      const result = validateMethodology('');
      expect(result).toBeDefined();
      expect(result).toContain('non-empty string');
    });

    it('should return error message for non-string values', () => {
      const result = validateMethodology(null as any);
      expect(result).toBeDefined();
      expect(result).toContain('non-empty string');
    });

    it('should return error message for unrecognized methodology with special chars', () => {
      const result = validateMethodology('INVALID!');
      expect(result).toBeDefined();
      expect(result).toContain('Invalid methodology');
      expect(result).toContain('INVALID!');
    });

    it('should return error message for wrong case methodology', () => {
      const result = validateMethodology('redd+');
      expect(result).toBeDefined();
      expect(result).toContain('Invalid methodology');
    });

    it('should return error message for methodology exceeding 50 characters', () => {
      const longMethodology = 'a'.repeat(51);
      const result = validateMethodology(longMethodology);
      expect(result).toBeDefined();
      expect(result).toContain('50 characters');
    });
  });
});
