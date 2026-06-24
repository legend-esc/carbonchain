import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import type { ProjectProfile } from '../shared';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @ApiOperation({ summary: 'Register a new project' })
  @Post()
  async create(@Body() data: CreateProjectDto): Promise<ProjectProfile> {
    return this.projectsService.createProject(data);
  }

  @ApiOperation({ summary: 'Get project by ID' })
  @Get(':id')
  async getOne(@Param('id') id: string): Promise<ProjectProfile> {
    return this.projectsService.getProject(id);
  }

  @ApiOperation({ summary: 'List all projects' })
  @Get()
  async list(): Promise<ProjectProfile[]> {
    return this.projectsService.listProjects();
  }

  @ApiOperation({
    summary:
      'List projects with pending status (reconciliation endpoint). These are projects where IPFS upload succeeded but contract call may have failed.',
  })
  @Get('reconciliation/pending')
  async getPending(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<{
    data: ProjectProfile[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.projectsService.getPendingProjects(page, limit);
  }
}
