import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ProjectProfile } from '../shared';
import { ProjectEntity, ProjectStatus } from './project.entity';
import type { IProjectRepository } from './project.repository';
import { PROJECT_REPOSITORY } from './project.repository';

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

  async createProject(
    data: Omit<ProjectProfile, 'id' | 'documents_cid'> & {
      documents?: Record<string, unknown>;
    },
  ): Promise<ProjectProfile> {
    const id = `proj_${Math.random().toString(36).substring(2, 11)}`;

    let documents_cid = '';
    if (data.documents) {
      try {
        documents_cid = await this.uploadToIpfs(data.documents);
        this.logger.log(`Uploaded project docs to IPFS: ${documents_cid}`);
      } catch (err) {
        this.logger.error('IPFS upload failed', err);
        throw err;
      }
    }

    // ── Step 1: Store IPFS CID with pending status ─────────────────────
    // This prevents the IPFS file from being orphaned if the contract call fails.
    // The record MUST be persisted before any contract invocation.
    const entity = new ProjectEntity();
    entity.id = id;
    entity.name = data.name;
    entity.developer = data.developer;
    entity.description = data.description;
    entity.location = data.location;
    entity.methodology = data.methodology;
    entity.documentsCid = documents_cid;
    entity.status = ProjectStatus.Pending;
    entity.createdAt = Math.floor(Date.now() / 1000);

    await this.projectRepo.save(entity);
    this.logger.log(
      `Project ${id} stored with pending status, CID: ${documents_cid}`,
    );

    // ── Step 2: Make contract call (placeholder for future implementation) ───
    // When implemented, update status to confirmed on success, failed on error.
    // For now, we mark as confirmed since there's no contract call yet.
    entity.status = ProjectStatus.Confirmed;
    entity.confirmedAt = Math.floor(Date.now() / 1000);
    await this.projectRepo.save(entity);
    this.logger.log(`Project ${id} confirmed`);

    const newProject: ProjectProfile = {
      id,
      name: data.name,
      developer: data.developer,
      description: data.description,
      location: data.location,
      methodology: data.methodology,
      documents_cid,
    };

    return newProject;
  }

  async getProject(id: string): Promise<ProjectProfile> {
    const project = await this.projectRepo.findById(id);
    if (!project)
      throw new NotFoundException(`Project with ID ${id} not found`);
    return this.entityToProfile(project);
  }

  async listProjects(): Promise<ProjectProfile[]> {
    const result = await this.projectRepo.findAll(1, 1000000);
    return result.data.map((e) => this.entityToProfile(e));
  }

  /**
   * Get all projects with pending status for reconciliation.
   * These are projects where IPFS upload succeeded but contract call failed or hung.
   * Callers can retry the contract call or manually investigate.
   */
  async getPendingProjects(
    page = 1,
    limit = 20,
  ): Promise<{
    data: ProjectProfile[];
    total: number;
    page: number;
    limit: number;
  }> {
    const result = await this.projectRepo.findPendingProjects(page, limit);
    return {
      ...result,
      data: result.data.map((e) => this.entityToProfile(e)),
    };
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
