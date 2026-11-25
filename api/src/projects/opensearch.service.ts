/**
 * #1309 — OpenSearch / Elastic indexing for natural language credit project search.
 *
 * Responsibilities:
 *  - Index a project document on create/update.
 *  - Fuzzy multi-field search across name, description, country, and methodology.
 *  - Return paginated results with relevance score and facet counts.
 *  - Fall back to SQL ILIKE when the OpenSearch cluster is offline.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import axios, { AxiosInstance } from 'axios';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ProjectSearchHit {
  id: string;
  name: string;
  description: string;
  /** `location` field re-exposed as `country` for the search contract. */
  country: string;
  methodology: string;
  score: number;
}

export interface FacetBucket {
  key: string;
  count: number;
}

export interface ProjectSearchResult {
  hits: ProjectSearchHit[];
  total: number;
  page: number;
  pageSize: number;
  facets: {
    methodology: FacetBucket[];
    country: FacetBucket[];
  };
  /** True when the result was produced by the SQL fallback path. */
  fallback: boolean;
}

export interface ProjectSearchQuery {
  q: string;
  methodology?: string;
  country?: string;
  page?: number;
  pageSize?: number;
}

// ── OpenSearch document shape ──────────────────────────────────────────────────

interface ProjectDocument {
  id: string;
  name: string;
  description: string;
  country: string;
  methodology: string;
  developer: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const INDEX_NAME = 'projects';
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class OpenSearchService {
  private readonly logger = new Logger(OpenSearchService.name);
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.baseUrl = this.config.get<string>(
      'OPENSEARCH_URL',
      'http://localhost:9200',
    );

    const username = this.config.get<string>('OPENSEARCH_USERNAME', '');
    const password = this.config.get<string>('OPENSEARCH_PASSWORD', '');

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 5_000,
      headers: { 'Content-Type': 'application/json' },
      ...(username && password ? { auth: { username, password } } : {}),
    });
  }

  // ── Index management ───────────────────────────────────────────────────────

  /**
   * Ensure the projects index exists with the correct field mappings.
   * Called once at bootstrap; idempotent — safe to run if index already exists.
   */
  async ensureIndex(): Promise<void> {
    try {
      await this.client.get(`/${INDEX_NAME}`);
      // Index already exists.
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        await this.client.put(`/${INDEX_NAME}`, {
          settings: { number_of_shards: 1, number_of_replicas: 1 },
          mappings: {
            properties: {
              id: { type: 'keyword' },
              name: { type: 'text', analyzer: 'standard' },
              description: { type: 'text', analyzer: 'standard' },
              country: { type: 'keyword' },
              methodology: { type: 'keyword' },
              developer: { type: 'text', analyzer: 'standard' },
            },
          },
        });
        this.logger.log(`OpenSearch index "${INDEX_NAME}" created`);
      } else {
        throw err;
      }
    }
  }

  // ── Indexing ───────────────────────────────────────────────────────────────

  /**
   * Upsert a project document into the search index.
   * Called by ProjectsService.createProject and on updates.
   */
  async indexProject(doc: ProjectDocument): Promise<void> {
    try {
      await this.client.put(`/${INDEX_NAME}/_doc/${doc.id}`, doc);
      this.logger.debug(`Indexed project ${doc.id}`);
    } catch (err) {
      // Non-fatal: log and continue — the SQL store is the source of truth.
      this.logger.warn(
        `Failed to index project ${doc.id}: ${(err as Error).message}`,
      );
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  /**
   * Execute a fuzzy natural language search against OpenSearch.
   * Falls back to SQL ILIKE when the cluster is unreachable.
   */
  async search(query: ProjectSearchQuery): Promise<ProjectSearchResult> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      query.pageSize ?? DEFAULT_PAGE_SIZE,
    );
    const from = (page - 1) * pageSize;

    // Build the filter array for methodology / country facets.
    const filters: unknown[] = [];
    if (query.methodology) {
      filters.push({ term: { methodology: query.methodology } });
    }
    if (query.country) {
      filters.push({ term: { country: query.country } });
    }

    const osQuery = {
      from,
      size: pageSize,
      query: {
        bool: {
          must: query.q
            ? [
                {
                  multi_match: {
                    query: query.q,
                    fields: [
                      'name^3',
                      'description',
                      'country',
                      'methodology^2',
                    ],
                    fuzziness: 'AUTO',
                    type: 'best_fields',
                  },
                },
              ]
            : [{ match_all: {} }],
          filter: filters,
        },
      },
      aggs: {
        by_methodology: {
          terms: { field: 'methodology', size: 20 },
        },
        by_country: {
          terms: { field: 'country', size: 50 },
        },
      },
      track_total_hits: true,
    };

    try {
      const response = await this.client.post<{
        hits: {
          total: { value: number };
          hits: Array<{
            _id: string;
            _score: number;
            _source: ProjectDocument;
          }>;
        };
        aggregations: {
          by_methodology: {
            buckets: Array<{ key: string; doc_count: number }>;
          };
          by_country: { buckets: Array<{ key: string; doc_count: number }> };
        };
      }>(`/${INDEX_NAME}/_search`, osQuery);

      const { hits, aggregations } = response.data;

      return {
        hits: hits.hits.map((h) => ({
          id: h._source.id,
          name: h._source.name,
          description: h._source.description,
          country: h._source.country,
          methodology: h._source.methodology,
          score: h._score,
        })),
        total: hits.total.value,
        page,
        pageSize,
        facets: {
          methodology: aggregations.by_methodology.buckets.map((b) => ({
            key: b.key,
            count: b.doc_count,
          })),
          country: aggregations.by_country.buckets.map((b) => ({
            key: b.key,
            count: b.doc_count,
          })),
        },
        fallback: false,
      };
    } catch (err) {
      this.logger.warn(
        `OpenSearch unavailable — falling back to SQL ILIKE: ${(err as Error).message}`,
      );
      return this.sqlFallbackSearch(query, page, pageSize);
    }
  }

  // ── SQL fallback ───────────────────────────────────────────────────────────

  /**
   * SQL ILIKE fallback for when the OpenSearch cluster is offline.
   * No relevance scoring; facet counts are approximated from the full result set.
   */
  private async sqlFallbackSearch(
    query: ProjectSearchQuery,
    page: number,
    pageSize: number,
  ): Promise<ProjectSearchResult> {
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (query.q) {
      const pattern = `%${query.q}%`;
      params.push(pattern);
      const idx = params.length;
      conditions.push(
        `(name ILIKE $${idx} OR description ILIKE $${idx} OR location ILIKE $${idx} OR methodology ILIKE $${idx})`,
      );
    }

    if (query.methodology) {
      params.push(query.methodology);
      conditions.push(`methodology = $${params.length}`);
    }

    if (query.country) {
      params.push(query.country);
      conditions.push(`location = $${params.length}`);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const rows = await this.dataSource.query<
      {
        id: string;
        name: string;
        description: string;
        location: string;
        methodology: string;
        developer: string;
      }[]
    >(
      `SELECT id, name, description, location, methodology, developer
         FROM projects
         ${where}
         ORDER BY name
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    const countRows = await this.dataSource.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM projects ${where}`,
      params,
    );
    const total = Number(countRows[0]?.count ?? 0);

    // Build approximate facet counts from the full result.
    const facetRows = await this.dataSource.query<
      { methodology: string; location: string; cnt: string }[]
    >(
      `SELECT methodology, location, COUNT(*)::text AS cnt
         FROM projects
         ${where}
         GROUP BY methodology, location`,
      params,
    );

    const methodologyMap = new Map<string, number>();
    const countryMap = new Map<string, number>();
    for (const r of facetRows) {
      if (r.methodology) {
        methodologyMap.set(
          r.methodology,
          (methodologyMap.get(r.methodology) ?? 0) + Number(r.cnt),
        );
      }
      if (r.location) {
        countryMap.set(
          r.location,
          (countryMap.get(r.location) ?? 0) + Number(r.cnt),
        );
      }
    }

    return {
      hits: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        country: r.location,
        methodology: r.methodology,
        score: 1,
      })),
      total,
      page,
      pageSize,
      facets: {
        methodology: Array.from(methodologyMap.entries()).map(
          ([key, count]) => ({ key, count }),
        ),
        country: Array.from(countryMap.entries()).map(([key, count]) => ({
          key,
          count,
        })),
      },
      fallback: true,
    };
  }
}
