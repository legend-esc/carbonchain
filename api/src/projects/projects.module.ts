import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { OpenSearchService } from './opensearch.service';
import {
  InMemoryProjectRepository,
  PROJECT_REPOSITORY,
} from './project.repository';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    // Required for @InjectDataSource() in OpenSearchService SQL fallback.
    TypeOrmModule.forFeature([]),
  ],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    OpenSearchService,
    { provide: PROJECT_REPOSITORY, useClass: InMemoryProjectRepository },
  ],
  exports: [ProjectsService, OpenSearchService],
})
export class ProjectsModule {}
