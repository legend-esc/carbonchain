/**
 * Unit tests for OpenSearchService (#1309).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import axios from 'axios';
import { OpenSearchService } from './opensearch.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal OpenSearch _search response. */
function buildOsResponse(
  hits: { id: string; name: string; description: string; country: string; methodology: string; developer: string }[],
  scores: number[] = [],
) {
  const methodologyCounts: Record<string, number> = {};
  const countryCounts: Record<string, number> = {};
  for (const h of hits) {
    methodologyCounts[h.methodology] = (methodologyCounts[h.methodology] ?? 0) + 1;
    countryCounts[h.country] = (countryCounts[h.country] ?? 0) + 1;
  }

  return {
    data: {
      hits: {
        total: { value: hits.length },
        hits: hits.map((h, i) => ({
          _id: h.id,
          _score: scores[i] ?? 1,
          _source: h,
        })),
      },
      aggregations: {
        by_methodology: {
          buckets: Object.entries(methodologyCounts).map(([key, doc_count]) => ({ key, doc_count })),
        },
        by_country: {
          buckets: Object.entries(countryCounts).map(([key, doc_count]) => ({ key, doc_count })),
        },
      },
    },
  };
}

/** Minimal SQL fallback DataSource mock. */
function buildMockDataSource(rows: { id: string; name: string; description: string; location: string; methodology: string; developer: string }[] = []) {
  return {
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('COUNT(*)')) return [{ count: String(rows.length) }];
      if (s.includes('GROUP BY')) {
        const methodologyCounts: Record<string, Record<string, number>> = {};
        for (const r of rows) {
          const key = `${r.methodology}::${r.location}`;
          methodologyCounts[key] = methodologyCounts[key] ?? { cnt: 0 };
          methodologyCounts[key].cnt = (methodologyCounts[key].cnt ?? 0) + 1;
        }
        return Object.entries(methodologyCounts).map(([key, v]) => {
          const [methodology, location] = key.split('::');
          return { methodology, location, cnt: String(v.cnt) };
        });
      }
      return rows;
    }),
  };
}

const mockConfigService = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'OPENSEARCH_URL') return 'http://localhost:9200';
    if (key === 'OPENSEARCH_USERNAME') return '';
    if (key === 'OPENSEARCH_PASSWORD') return '';
    return def;
  }),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OpenSearchService', () => {
  let service: OpenSearchService;
  let axiosInstance: jest.Mocked<{ get: jest.Mock; post: jest.Mock; put: jest.Mock }>;

  const sampleProject = {
    id: 'proj-1',
    name: 'Amazon Reforestation',
    description: 'Reforesting the Amazon basin',
    country: 'Brazil',
    methodology: 'VCS',
    developer: 'dev-1',
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // axios.create returns a mocked instance.
    axiosInstance = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
    };
    mockedAxios.create = jest.fn().mockReturnValue(axiosInstance);
    mockedAxios.isAxiosError = jest.fn().mockReturnValue(false) as jest.MockedFunction<typeof axios.isAxiosError>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenSearchService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getDataSourceToken(), useValue: buildMockDataSource([]) },
      ],
    }).compile();

    service = module.get<OpenSearchService>(OpenSearchService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── ensureIndex ────────────────────────────────────────────────────────────

  describe('ensureIndex', () => {
    it('does nothing when the index already exists (200)', async () => {
      axiosInstance.get.mockResolvedValueOnce({ status: 200 });

      await expect(service.ensureIndex()).resolves.toBeUndefined();
      expect(axiosInstance.put).not.toHaveBeenCalled();
    });

    it('creates the index when OpenSearch returns 404', async () => {
      const error = Object.assign(new Error('Not Found'), { response: { status: 404 } });
      (mockedAxios.isAxiosError as jest.Mock).mockReturnValueOnce(true);
      axiosInstance.get.mockRejectedValueOnce(error);
      axiosInstance.put.mockResolvedValueOnce({ status: 200 });

      await expect(service.ensureIndex()).resolves.toBeUndefined();
      expect(axiosInstance.put).toHaveBeenCalledWith(
        '/projects',
        expect.objectContaining({ settings: expect.any(Object), mappings: expect.any(Object) }),
      );
    });

    it('re-throws non-404 errors', async () => {
      const error = Object.assign(new Error('Server Error'), { response: { status: 500 } });
      (mockedAxios.isAxiosError as jest.Mock).mockReturnValueOnce(true);
      axiosInstance.get.mockRejectedValueOnce(error);

      await expect(service.ensureIndex()).rejects.toThrow('Server Error');
    });
  });

  // ── indexProject ───────────────────────────────────────────────────────────

  describe('indexProject', () => {
    it('PUTs the document at the correct path', async () => {
      axiosInstance.put.mockResolvedValueOnce({ status: 200 });

      await service.indexProject(sampleProject);

      expect(axiosInstance.put).toHaveBeenCalledWith(
        `/projects/_doc/${sampleProject.id}`,
        sampleProject,
      );
    });

    it('does not throw when the PUT fails (non-fatal)', async () => {
      axiosInstance.put.mockRejectedValueOnce(new Error('timeout'));

      await expect(service.indexProject(sampleProject)).resolves.toBeUndefined();
    });
  });

  // ── search (OpenSearch path) ───────────────────────────────────────────────

  describe('search — OpenSearch path', () => {
    it('returns hits and facets from a successful OpenSearch response', async () => {
      axiosInstance.post.mockResolvedValueOnce(buildOsResponse([sampleProject], [1.5]));

      const result = await service.search({ q: 'amazon' });

      expect(result.fallback).toBe(false);
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].id).toBe('proj-1');
      expect(result.hits[0].score).toBe(1.5);
      expect(result.facets.methodology).toEqual(
        expect.arrayContaining([{ key: 'VCS', count: 1 }]),
      );
      expect(result.facets.country).toEqual(
        expect.arrayContaining([{ key: 'Brazil', count: 1 }]),
      );
    });

    it('passes methodology and country filters as term queries', async () => {
      axiosInstance.post.mockResolvedValueOnce(buildOsResponse([]));

      await service.search({ q: '', methodology: 'VCS', country: 'Brazil' });

      const [, body] = axiosInstance.post.mock.calls[0] as [string, { query: { bool: { filter: unknown[] } } }];
      expect(body.query.bool.filter).toEqual(
        expect.arrayContaining([
          { term: { methodology: 'VCS' } },
          { term: { country: 'Brazil' } },
        ]),
      );
    });

    it('uses match_all when query string is empty', async () => {
      axiosInstance.post.mockResolvedValueOnce(buildOsResponse([]));

      await service.search({ q: '' });

      const [, body] = axiosInstance.post.mock.calls[0] as [string, { query: { bool: { must: unknown[] } } }];
      expect(body.query.bool.must[0]).toEqual({ match_all: {} });
    });

    it('reports total and page metadata', async () => {
      axiosInstance.post.mockResolvedValueOnce(buildOsResponse([sampleProject]));

      const result = await service.search({ q: 'test', page: 2, pageSize: 5 });

      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(5);
      expect(result.total).toBe(1);
    });
  });

  // ── search (SQL fallback path) ─────────────────────────────────────────────

  describe('search — SQL fallback', () => {
    let serviceWithRows: OpenSearchService;
    const dbRow = {
      id: 'proj-fb',
      name: 'Fallback Project',
      description: 'A project',
      location: 'Kenya',
      methodology: 'Gold Standard',
      developer: 'dev-fb',
    };

    beforeEach(async () => {
      axiosInstance.post.mockRejectedValue(new Error('connection refused'));

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          OpenSearchService,
          { provide: ConfigService, useValue: mockConfigService },
          { provide: getDataSourceToken(), useValue: buildMockDataSource([dbRow]) },
        ],
      }).compile();

      serviceWithRows = module.get<OpenSearchService>(OpenSearchService);
      // Inject the same mocked axios instance.
      (serviceWithRows as unknown as { client: typeof axiosInstance }).client = axiosInstance;
    });

    it('returns fallback=true on OpenSearch failure', async () => {
      const result = await serviceWithRows.search({ q: 'fallback' });

      expect(result.fallback).toBe(true);
    });

    it('maps location to country in fallback results', async () => {
      const result = await serviceWithRows.search({ q: 'fallback' });

      expect(result.hits[0].country).toBe('Kenya');
    });

    it('returns total from SQL COUNT', async () => {
      const result = await serviceWithRows.search({ q: 'fallback' });

      expect(result.total).toBe(1);
    });
  });
});
