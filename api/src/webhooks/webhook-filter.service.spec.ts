/**
 * Unit tests for WebhookFilterService (#1307).
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  WebhookFilterService,
  type WebhookFilterCriteria,
  type FilterableEventPayload,
} from './webhook-filter.service';

describe('WebhookFilterService', () => {
  let service: WebhookFilterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhookFilterService],
    }).compile();

    service = module.get<WebhookFilterService>(WebhookFilterService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── shouldDeliver ─────────────────────────────────────────────────────────

  describe('shouldDeliver', () => {
    it('returns true when criteria is null (default-allow)', () => {
      expect(service.shouldDeliver('credit.retired', {}, null)).toBe(true);
    });

    it('returns true when criteria is undefined (default-allow)', () => {
      expect(service.shouldDeliver('credit.retired', {}, undefined)).toBe(true);
    });

    it('returns true when criteria is an empty object', () => {
      expect(service.shouldDeliver('credit.retired', {}, {})).toBe(true);
    });

    describe('event_types filter', () => {
      const criteria: WebhookFilterCriteria = {
        event_types: ['credit.retired', 'offer.created'],
      };

      it('allows an event whose type is in the list', () => {
        expect(service.shouldDeliver('credit.retired', {}, criteria)).toBe(
          true,
        );
      });

      it('blocks an event whose type is not in the list', () => {
        expect(service.shouldDeliver('offer.cancelled', {}, criteria)).toBe(
          false,
        );
      });
    });

    describe('methodologies filter', () => {
      const criteria: WebhookFilterCriteria = {
        methodologies: ['VCS', 'Gold Standard'],
      };

      it('allows an event whose methodology matches', () => {
        const payload: FilterableEventPayload = { methodology: 'VCS' };
        expect(service.shouldDeliver('credit.retired', payload, criteria)).toBe(
          true,
        );
      });

      it('blocks an event whose methodology does not match', () => {
        const payload: FilterableEventPayload = { methodology: 'CDM' };
        expect(service.shouldDeliver('credit.retired', payload, criteria)).toBe(
          false,
        );
      });

      it('blocks an event with no methodology field', () => {
        expect(service.shouldDeliver('credit.retired', {}, criteria)).toBe(
          false,
        );
      });
    });

    describe('min_tonnes filter', () => {
      const criteria: WebhookFilterCriteria = { min_tonnes: 100 };

      it('allows an event with tonnes_retired >= min_tonnes', () => {
        expect(
          service.shouldDeliver(
            'credit.retired',
            { tonnes_retired: 150 },
            criteria,
          ),
        ).toBe(true);
      });

      it('allows exact boundary (tonnes_retired === min_tonnes)', () => {
        expect(
          service.shouldDeliver(
            'credit.retired',
            { tonnes_retired: 100 },
            criteria,
          ),
        ).toBe(true);
      });

      it('blocks an event with tonnes_retired < min_tonnes', () => {
        expect(
          service.shouldDeliver(
            'credit.retired',
            { tonnes_retired: 50 },
            criteria,
          ),
        ).toBe(false);
      });

      it('accepts string tonnes_retired (numeric coercion)', () => {
        expect(
          service.shouldDeliver(
            'credit.retired',
            { tonnes_retired: '200' },
            criteria,
          ),
        ).toBe(true);
      });

      it('accepts the tonnes field (offer events)', () => {
        expect(
          service.shouldDeliver('offer.created', { tonnes: 500 }, criteria),
        ).toBe(true);
      });

      it('blocks when no tonnage field is present', () => {
        expect(service.shouldDeliver('offer.created', {}, criteria)).toBe(
          false,
        );
      });
    });

    describe('combined filters', () => {
      const criteria: WebhookFilterCriteria = {
        event_types: ['credit.retired'],
        methodologies: ['VCS'],
        min_tonnes: 10,
      };

      it('allows an event passing all criteria', () => {
        const payload: FilterableEventPayload = {
          methodology: 'VCS',
          tonnes_retired: 50,
        };
        expect(service.shouldDeliver('credit.retired', payload, criteria)).toBe(
          true,
        );
      });

      it('blocks when event_type fails even if the rest pass', () => {
        const payload: FilterableEventPayload = {
          methodology: 'VCS',
          tonnes_retired: 50,
        };
        expect(service.shouldDeliver('offer.created', payload, criteria)).toBe(
          false,
        );
      });

      it('blocks when methodology fails even if the rest pass', () => {
        const payload: FilterableEventPayload = {
          methodology: 'CDM',
          tonnes_retired: 50,
        };
        expect(service.shouldDeliver('credit.retired', payload, criteria)).toBe(
          false,
        );
      });

      it('blocks when min_tonnes fails even if the rest pass', () => {
        const payload: FilterableEventPayload = {
          methodology: 'VCS',
          tonnes_retired: 5,
        };
        expect(service.shouldDeliver('credit.retired', payload, criteria)).toBe(
          false,
        );
      });
    });
  });

  // ── parseCriteria ─────────────────────────────────────────────────────────

  describe('parseCriteria', () => {
    it('returns null for null input', () => {
      expect(service.parseCriteria(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(service.parseCriteria(undefined)).toBeNull();
    });

    it('parses a valid JSON string', () => {
      const raw = JSON.stringify({
        methodologies: ['VCS'],
        min_tonnes: 10,
        event_types: ['credit.retired'],
      });
      const result = service.parseCriteria(raw);
      expect(result).toEqual({
        methodologies: ['VCS'],
        min_tonnes: 10,
        event_types: ['credit.retired'],
      });
    });

    it('parses a plain object (already deserialized)', () => {
      const raw = { methodologies: ['Gold Standard'], min_tonnes: 5 };
      const result = service.parseCriteria(raw);
      expect(result).toEqual({
        methodologies: ['Gold Standard'],
        min_tonnes: 5,
      });
    });

    it('returns null for a malformed JSON string', () => {
      expect(service.parseCriteria('{not valid json')).toBeNull();
    });

    it('returns null for a JSON array (not an object)', () => {
      expect(service.parseCriteria('["a","b"]')).toBeNull();
    });

    it('ignores non-string values inside methodologies array', () => {
      const raw = { methodologies: ['VCS', 42, null, 'GS'] };
      const result = service.parseCriteria(raw);
      expect(result?.methodologies).toEqual(['VCS', 'GS']);
    });

    it('ignores a non-numeric min_tonnes', () => {
      const raw = { min_tonnes: 'ten' };
      const result = service.parseCriteria(raw);
      expect(result?.min_tonnes).toBeUndefined();
    });

    it('returns an object with only the recognised fields', () => {
      const raw = { methodologies: ['VCS'], unknown_field: true };
      const result = service.parseCriteria(raw);
      expect(result).not.toHaveProperty('unknown_field');
    });
  });
});
