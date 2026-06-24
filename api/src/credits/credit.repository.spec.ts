import { CreditRepository, CreditRecord } from './credit.repository';

describe('CreditRepository', () => {
  let repo: CreditRepository;

  const seed: CreditRecord[] = [
    { id: '1', methodology: 'VCS', geography: 'NG', vintage_year: 2023 },
    { id: '2', methodology: 'Gold Standard', geography: 'KE', vintage_year: 2024 },
  ];

  beforeEach(() => {
    repo = new CreditRepository();
    repo.seed(seed);
  });

  describe('findByFilter — SQL injection regression (#68)', () => {
    it('returns no records when methodology is a tautological injection payload', () => {
      const results = repo.findByFilter({ methodology: "' OR '1'='1" });
      expect(results).toHaveLength(0);
    });

    it('returns no records when methodology is a DROP TABLE injection payload', () => {
      const results = repo.findByFilter({ methodology: "; DROP TABLE credits; --" });
      expect(results).toHaveLength(0);
    });
  });

  describe('findByFilter — normal behaviour', () => {
    it('returns matching records for a valid methodology', () => {
      const results = repo.findByFilter({ methodology: 'VCS' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('1');
    });

    it('returns empty array when no records match', () => {
      expect(repo.findByFilter({ methodology: 'CDM' })).toHaveLength(0);
    });
  });
});
