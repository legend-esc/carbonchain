import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ProjectsService, VerifyResult } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import type { ProjectProfile } from '../../../shared';
import { Idempotent } from '../common/idempotency.interceptor';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @ApiOperation({ summary: 'Register a new project' })
  @Idempotent()
  @Post()
  async create(@Body() data: CreateProjectDto): Promise<ProjectProfile> {
    return this.projectsService.createProject(data);
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
