import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ProjectProfile } from '../../../shared';
import { PROJECT_REPOSITORY } from './project.repository';
import type { IProjectRepository } from './project.repository';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  private readonly projects = new Map<string, ProjectProfile>();

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(PROJECT_REPOSITORY)
    private readonly projectRepository?: IProjectRepository,
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

    const newProject: ProjectProfile = {
      id,
      name: data.name,
      developer: data.developer,
      description: data.description,
      location: data.location,
      methodology: data.methodology,
      documents_cid,
    };

    if (this.projectRepository) await this.projectRepository.save(newProject);
    else this.projects.set(id, newProject);
    this.logger.log(`Project created with ID: ${id}`);
    return newProject;
  }

  async getProject(id: string): Promise<ProjectProfile> {
    const project = this.projectRepository
      ? await this.projectRepository.findById(id)
      : this.projects.get(id);
    if (!project)
      throw new NotFoundException(`Project with ID ${id} not found`);
    return project;
  }

  async listProjects(): Promise<ProjectProfile[]> {
    return this.projectRepository
      ? this.projectRepository.findAll()
      : Array.from(this.projects.values());
  }
}
