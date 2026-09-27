import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import {
  InMemoryProjectRepository,
  PROJECT_REPOSITORY,
} from './project.repository';

@Module({
  imports: [ConfigModule, ScheduleModule.forRoot()],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    { provide: PROJECT_REPOSITORY, useClass: InMemoryProjectRepository },
  ],
  exports: [ProjectsService],
})
export class ProjectsModule {}
