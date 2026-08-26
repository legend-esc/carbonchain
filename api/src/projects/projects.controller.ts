import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import type { ProjectProfile } from '../../../shared';

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
    return this.projectsService.getProjectAsync(id);
  }

  @ApiOperation({ summary: 'List all projects' })
  @Get()
  async list(): Promise<ProjectProfile[]> {
    return this.projectsService.listProjects();
  }
}
