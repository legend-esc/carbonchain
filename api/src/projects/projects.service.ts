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
import { uploadToIpfsWithRetry } from './ipfs-upload-retry.util';
import { isValidIpfsCid } from '../common/ipfs-cid.util';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  private readonly ipfsTimeoutMs = 30_000;

  constructor(
    private readonly config: ConfigService,
    @Inject(PROJECT_REPOSITORY)
    private readonly projectRepo: IProjectRepository,
  ) {
    this.ipfsTimeoutMs = Number(
      this.config.get<number>('IPFS_TIMEOUT_MS', 30_000),
    );
  }

  /** Upload a JSON document to Pinata and return the IPFS CID. */
  async uploadToIpfs(document: Record<string, unknown>): Promise<string> {
    const apiKey = this.config.get<string>('IPFS_API_KEY', '');
    const secretKey = this.config.get<string>('IPFS_SECRET_KEY', '');
    const baseUrl = this.config.get<string>(
      'IPFS_API_URL',
      'https://api.pinata.cloud',
    );

    const response = await uploadToIpfsWithRetry(() =>
      axios.post<{ IpfsHash: string }>(
        `${baseUrl}/pinning/pinJSONToIPFS`,
        { pinataContent: document },
        {
          headers: {
            pinata_api_key: apiKey,
            pinata_secret_api_key: secretKey,
            'Content-Type': 'application/json',
          },
          timeout: this.ipfsTimeoutMs,
        },
      ),
    );

    const cid = response.data.IpfsHash;
    if (!isValidIpfsCid(cid)) {
      throw new InternalServerErrorException(
        `Pinata returned an invalid IPFS CID: ${cid}`,
      );
    }
    return cid;
  }

  /**
   * Create a new project and persist it to the database.
   *
   * The IPFS document upload is required: if it fails the project is NOT
   * persisted with an empty `documents_cid` (that would create a silently
   * incomplete record). The caller must retry or supply documents later.
   */
  async createProject(
    data: Omit<ProjectProfile, 'id' | 'documents_cid'> & {
      documents?: Record<string, unknown>;
    },
  ): Promise<ProjectProfile> {
    const id = crypto.randomUUID();

    let documents_cid = '';
    if (data.documents) {
      documents_cid = await this.uploadToIpfs(data.documents);
      this.logger.log(`Uploaded project docs to IPFS: ${documents_cid}`);
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

  async getProject(id: string): Promise<ProjectProfile> {
    // Delegates to the async repository-backed lookup. Kept for callers that
    // expected a getProject entrypoint; the synchronous throw-NotFound version
    // was dead/buggy code.
    return this.getProjectAsync(id);
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
