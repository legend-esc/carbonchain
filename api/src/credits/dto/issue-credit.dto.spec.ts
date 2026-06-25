import { validate } from 'class-validator';
import { IssueCreditDto } from './issue-credit.dto';
import { plainToClass } from 'class-transformer';

describe('IssueCreditDto', () => {
  describe('methodology field validation', () => {
    it('should accept valid methodologies', async () => {
      const validMethodologies = [
        'REDD+',
        'VCS',
        'Gold Standard',
        'CDM',
        'Plan Vivo',
      ];

      for (const methodology of validMethodologies) {
        const dto = plainToClass(IssueCreditDto, {
          issuerPublicKey: 'GABC123',
          projectId: 'PROJ-001',
          vintageYear: 2024,
          methodology,
          geography: 'NG',
          tonnes: '1000000',
          ipfsHash: 'bafybei123',
        });

        const errors = await validate(dto);
        const methodologyErrors = errors.filter(
          (e) => e.property === 'methodology',
        );
        expect(methodologyErrors).toHaveLength(0);
      }
    });

    it('should reject empty methodology', async () => {
      const dto = plainToClass(IssueCreditDto, {
        issuerPublicKey: 'GABC123',
        projectId: 'PROJ-001',
        vintageYear: 2024,
        methodology: '',
        geography: 'NG',
        tonnes: '1000000',
        ipfsHash: 'bafybei123',
      });

      const errors = await validate(dto);
      const methodologyErrors = errors.filter(
        (e) => e.property === 'methodology',
      );
      expect(methodologyErrors.length).toBeGreaterThan(0);
    });

    it('should accept custom methodology like "FAKE"', async () => {
      const dto = plainToClass(IssueCreditDto, {
        issuerPublicKey: 'GABC123',
        projectId: 'PROJ-001',
        vintageYear: 2024,
        methodology: 'FAKE',
        geography: 'NG',
        tonnes: '1000000',
        ipfsHash: 'bafybei123',
      });

      const errors = await validate(dto);
      const methodologyErrors = errors.filter(
        (e) => e.property === 'methodology',
      );
      expect(methodologyErrors).toHaveLength(0);
    });

    it('should reject case-sensitive methodology like "redd+"', async () => {
      const dto = plainToClass(IssueCreditDto, {
        issuerPublicKey: 'GABC123',
        projectId: 'PROJ-001',
        vintageYear: 2024,
        methodology: 'redd+',
        geography: 'NG',
        tonnes: '1000000',
        ipfsHash: 'bafybei123',
      });

      const errors = await validate(dto);
      const methodologyErrors = errors.filter(
        (e) => e.property === 'methodology',
      );
      expect(methodologyErrors.length).toBeGreaterThan(0);
    });

    it('should accept valid custom methodologies', async () => {
      const customMethodologies = [
        'Custom-Method-1',
        'My-Carbon-Offset',
        'test_methodology',
      ];

      for (const methodology of customMethodologies) {
        const dto = plainToClass(IssueCreditDto, {
          issuerPublicKey: 'GABC123',
          projectId: 'PROJ-001',
          vintageYear: 2024,
          methodology,
          geography: 'NG',
          tonnes: '1000000',
          ipfsHash: 'bafybei123',
        });

        const errors = await validate(dto);
        const methodologyErrors = errors.filter(
          (e) => e.property === 'methodology',
        );
        expect(methodologyErrors).toHaveLength(0);
      }
    });

    it('should reject invalid custom methodologies with special characters', async () => {
      const invalidMethodologies = [
        'Method@Name',
        'Method!Name',
        'Method#Name',
      ];

      for (const methodology of invalidMethodologies) {
        const dto = plainToClass(IssueCreditDto, {
          issuerPublicKey: 'GABC123',
          projectId: 'PROJ-001',
          vintageYear: 2024,
          methodology,
          geography: 'NG',
          tonnes: '1000000',
          ipfsHash: 'bafybei123',
        });

        const errors = await validate(dto);
        const methodologyErrors = errors.filter(
          (e) => e.property === 'methodology',
        );
        expect(methodologyErrors.length).toBeGreaterThan(0);
      }
    });

    it('should require methodology to be non-empty', async () => {
      const dto = plainToClass(IssueCreditDto, {
        issuerPublicKey: 'GABC123',
        projectId: 'PROJ-001',
        vintageYear: 2024,
        // methodology is missing
        geography: 'NG',
        tonnes: '1000000',
        ipfsHash: 'bafybei123',
      });

      const errors = await validate(dto);
      const methodologyErrors = errors.filter(
        (e) => e.property === 'methodology',
      );
      expect(methodologyErrors.length).toBeGreaterThan(0);
    });

    it('should reject methodology exceeding 50 characters', async () => {
      const longMethodology = 'a'.repeat(51);
      const dto = plainToClass(IssueCreditDto, {
        issuerPublicKey: 'GABC123',
        projectId: 'PROJ-001',
        vintageYear: 2024,
        methodology: longMethodology,
        geography: 'NG',
        tonnes: '1000000',
        ipfsHash: 'bafybei123',
      });

      const errors = await validate(dto);
      const methodologyErrors = errors.filter(
        (e) => e.property === 'methodology',
      );
      expect(methodologyErrors.length).toBeGreaterThan(0);
    });
  });

  describe('tonnes field validation', () => {
    it('should accept tonnes that is a multiple of 100,000', async () => {
      const validTonnes = ['100000', '1000000', '5000000', '100000000'];

      for (const tonnes of validTonnes) {
        const dto = plainToClass(IssueCreditDto, {
          issuerPublicKey: 'GABC123',
          projectId: 'PROJ-001',
          vintageYear: 2024,
          methodology: 'VCS',
          geography: 'NG',
          tonnes,
          ipfsHash: 'bafybei123',
        });

        const errors = await validate(dto);
        const tonnesErrors = errors.filter((e) => e.property === 'tonnes');
        expect(tonnesErrors).toHaveLength(0);
      }
    });

    it('should reject tonnes that is not a multiple of 100,000', async () => {
      const invalidTonnes = ['1', '50000', '150000', '1000001', '999999'];

      for (const tonnes of invalidTonnes) {
        const dto = plainToClass(IssueCreditDto, {
          issuerPublicKey: 'GABC123',
          projectId: 'PROJ-001',
          vintageYear: 2024,
          methodology: 'VCS',
          geography: 'NG',
          tonnes,
          ipfsHash: 'bafybei123',
        });

        const errors = await validate(dto);
        const tonnesErrors = errors.filter((e) => e.property === 'tonnes');
        expect(tonnesErrors.length).toBeGreaterThan(0);
        expect(tonnesErrors[0].constraints?.isTonnesMultiple).toContain(
          'must be a multiple of 100,000',
        );
      }
    });

    it('should reject negative tonnes', async () => {
      const dto = plainToClass(IssueCreditDto, {
        issuerPublicKey: 'GABC123',
        projectId: 'PROJ-001',
        vintageYear: 2024,
        methodology: 'VCS',
        geography: 'NG',
        tonnes: '-100000',
        ipfsHash: 'bafybei123',
      });

      const errors = await validate(dto);
      const tonnesErrors = errors.filter((e) => e.property === 'tonnes');
      expect(tonnesErrors.length).toBeGreaterThan(0);
    });

    it('should reject non-numeric tonnes', async () => {
      const dto = plainToClass(IssueCreditDto, {
        issuerPublicKey: 'GABC123',
        projectId: 'PROJ-001',
        vintageYear: 2024,
        methodology: 'VCS',
        geography: 'NG',
        tonnes: 'abc',
        ipfsHash: 'bafybei123',
      });

      const errors = await validate(dto);
      const tonnesErrors = errors.filter((e) => e.property === 'tonnes');
      expect(tonnesErrors.length).toBeGreaterThan(0);
    });
  });

  describe('complete DTO validation', () => {
    it('should validate complete valid DTO', async () => {
      const dto = plainToClass(IssueCreditDto, {
        issuerPublicKey: 'GABC123',
        projectId: 'PROJ-001',
        vintageYear: 2024,
        methodology: 'VCS',
        geography: 'NG',
        tonnes: '1000000',
        ipfsHash: 'bafybei123',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should reject DTO with invalid methodology (contains special chars) and valid other fields', async () => {
      const dto = plainToClass(IssueCreditDto, {
        issuerPublicKey: 'GABC123',
        projectId: 'PROJ-001',
        vintageYear: 2024,
        methodology: 'INVALID!',
        geography: 'NG',
        tonnes: '1000000',
        ipfsHash: 'bafybei123',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      const methodologyErrors = errors.filter(
        (e) => e.property === 'methodology',
      );
      expect(methodologyErrors.length).toBeGreaterThan(0);
    });
  });
});
