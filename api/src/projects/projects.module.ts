import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectEntity } from './project.entity';
import { PROJECT_REPOSITORY, TypeOrmProjectRepository } from './project.repository';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([ProjectEntity])],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    { provide: PROJECT_REPOSITORY, useClass: TypeOrmProjectRepository },
  ],
  exports: [ProjectsService],
})
export class ProjectsModule {}
