import { Controller, Get, Post, Body, Param } from '@nestjs/common';
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
  getOne(@Param('id') id: string): ProjectProfile {
    return this.projectsService.getProject(id);
  }

  @ApiOperation({ summary: 'List all projects' })
  @Get()
  list(): ProjectProfile[] {
    return this.projectsService.listProjects();
  }
}
