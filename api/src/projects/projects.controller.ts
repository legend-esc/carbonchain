import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProjectsService, VerifyResult } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import {
  OpenSearchService,
  type ProjectSearchResult,
} from './opensearch.service';
import type { ProjectProfile } from '../../../shared';
import { Idempotent } from '../common/idempotency.interceptor';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly openSearchService: OpenSearchService,
  ) {}

  @ApiOperation({ summary: 'Register a new project' })
  @Idempotent()
  @Post()
  async create(@Body() data: CreateProjectDto): Promise<ProjectProfile> {
    return this.projectsService.createProject(data);
  }

  /**
   * #1309 — GET /projects/search
   *
   * Natural language fuzzy search backed by OpenSearch with SQL ILIKE fallback.
   * Supports methodology and country filters; returns paginated hits with
   * relevance scores and facet counts.
   */
  @ApiOperation({ summary: 'Natural language search across projects' })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Free-text search query',
  })
  @ApiQuery({
    name: 'methodology',
    required: false,
    description: 'Filter by exact methodology',
  })
  @ApiQuery({
    name: 'country',
    required: false,
    description: 'Filter by country / location',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (1-based, default 1)',
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Results per page (default 10, max 100)',
  })
  @Get('search')
  async search(
    @Query('q') q?: string,
    @Query('methodology') methodology?: string,
    @Query('country') country?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<ProjectSearchResult> {
    return this.openSearchService.search({
      q: q ?? '',
      methodology,
      country,
      page: page ? Math.max(1, parseInt(page, 10)) : 1,
      pageSize: pageSize
        ? Math.min(100, Math.max(1, parseInt(pageSize, 10)))
        : 10,
    });
  }

  @ApiOperation({ summary: 'Get project by ID' })
  @Get(':id')
  async getOne(@Param('id') id: string): Promise<ProjectProfile> {
    return this.projectsService.getProjectAsync(id);
  }

  @ApiOperation({ summary: 'List all projects' })
  @Get()
  async list(): Promise<ProjectProfile[]> {
    return this.projectsService.listProjects();
  }

  /**
   * #928 — GET /projects/:id/verify
   *
   * Probes the project's IPFS CID availability via Pinata and optionally
   * compares a caller-supplied expected hash against the stored CID.
   *
   * Response shape: { projectId, cid, cidMatch, pinned, hashOk, checkedAt }
   *
   * Results are cached for 5 minutes per project to avoid hammering Pinata.
   */
  @ApiOperation({
    summary: 'Verify IPFS CID availability and content hash for a project',
  })
  @ApiQuery({
    name: 'expectedHash',
    required: false,
    description: 'Expected CID to compare against the stored value',
  })
  @Get(':id/verify')
  async verifyCid(
    @Param('id') id: string,
    @Query('expectedHash') expectedHash?: string,
  ): Promise<VerifyResult> {
    return this.projectsService.verifyProjectCid(id, expectedHash);
  }
}
