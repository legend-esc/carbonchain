import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ProjectProfile } from '../../../shared';
import { ProjectEntity } from './project.entity';
import type { IProjectRepository } from './project.repository';
import { PROJECT_REPOSITORY } from './project.repository';
import { Inject } from '@nestjs/common';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject(PROJECT_REPOSITORY)
    private readonly projectRepo: IProjectRepository,
  ) {}

  /** Upload a JSON document to Pinata and return the IPFS CID. */
  async uploadToIpfs(document: Record<string, unknown>): Promise<string> {
    const apiKey = this.config.get<string>('IPFS_API_KEY', '');
    const secretKey = this.config.get<string>('IPFS_SECRET_KEY', '');
    const baseUrl = this.config.get<string>(
      'IPFS_API_URL',
      'https://api.pinata.cloud',
    );

    const response = await axios.post<{ IpfsHash: string }>(
      `${baseUrl}/pinning/pinJSONToIPFS`,
      { pinataContent: document },
      {
        headers: {
          pinata_api_key: apiKey,
          pinata_secret_api_key: secretKey,
          'Content-Type': 'application/json',
        },
      },
    );

    return response.data.IpfsHash;
  }

  /**
   * Create a new project and persist it to the database.
   *
   * Approach: The project row is persisted BEFORE the IPFS upload.
   * If the IPFS upload fails, the row remains with an empty documents_cid.
   * The caller can retry the IPFS upload separately or update the project later.
   * This ensures the project is always persisted even if IPFS is temporarily unavailable.
   */
  async createProject(
    data: Omit<ProjectProfile, 'id' | 'documents_cid'> & {
      documents?: Record<string, unknown>;
    },
  ): Promise<ProjectProfile> {
    const id = crypto.randomUUID();

    let documents_cid = '';
    if (data.documents) {
      try {
        documents_cid = await this.uploadToIpfs(data.documents);
        this.logger.log(`Uploaded project docs to IPFS: ${documents_cid}`);
      } catch (err) {
        this.logger.error(
          'IPFS upload failed — project will be persisted without documents_cid',
          err,
        );
        // Continue without IPFS — the project row is still created
      }
    }

    const entity = new ProjectEntity();
    entity.id = id;
    entity.name = data.name;
    entity.developer = data.developer ?? '';
    entity.description = data.description ?? '';
    entity.location = data.location ?? '';
    entity.methodology = data.methodology ?? '';
    entity.documentsCid = documents_cid;

    await this.projectRepo.save(entity);
    this.logger.log(`Project created with ID: ${id}`);

    return this.entityToProfile(entity);
  }

  getProject(id: string): ProjectProfile {
    // Note: This is synchronous for backward compatibility.
    // For async DB access, use getProjectAsync instead.
    throw new NotFoundException(`Project with ID ${id} not found`);
  }

  async getProjectAsync(id: string): Promise<ProjectProfile> {
    const entity = await this.projectRepo.findById(id);
    if (!entity) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }
    return this.entityToProfile(entity);
  }

  async listProjects(): Promise<ProjectProfile[]> {
    const entities = await this.projectRepo.findAll();
    return entities.map((e) => this.entityToProfile(e));
  }

  private entityToProfile(entity: ProjectEntity): ProjectProfile {
    return {
      id: entity.id,
      name: entity.name,
      developer: entity.developer,
      description: entity.description,
      location: entity.location,
      methodology: entity.methodology,
      documents_cid: entity.documentsCid,
    };
  }
}
