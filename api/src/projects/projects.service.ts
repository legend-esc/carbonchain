/**
 * ProjectsService
 *
 * Handles project creation with IPFS document upload.
 *
 * #928 — Adds:
 *  - Scheduled nightly re-pin job (verifyAndRepinAll) that probes every
 *    project CID via the Pinata is_pinned API and re-pins any that have
 *    been garbage-collected.
 *  - verifyProjectCid(id) — used by GET /projects/:id/verify to check
 *    CID availability and optionally compare a provided content hash.
 *  Results are cached for VERIFY_CACHE_TTL_MS to avoid hammering Pinata
 *  on repeated calls.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { ProjectProfile } from '../../../shared';
import { ProjectEntity } from './project.entity';
import type { IProjectRepository } from './project.repository';
import { PROJECT_REPOSITORY } from './project.repository';
import { Inject } from '@nestjs/common';
import { uploadToIpfsWithRetry } from './ipfs-upload-retry.util';
import { isValidIpfsCid } from '../common/ipfs-cid.util';
import client from 'prom-client';

// ── Types ──────────────────────────────────────────────────────────────────

export interface VerifyResult {
  projectId: string;
  cid: string;
  cidMatch: boolean;
  pinned: boolean;
  hashOk: boolean;
  checkedAt: string;
}

// ── Constants ─────────────────────────────────────────────────────────────

/** How long to cache a verify result per project (ms). */
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  private ipfsTimeoutMs: number = 30_000;

  // Simple in-process verify-result cache keyed by project id.
  private readonly verifyCache = new Map<
    string,
    { result: VerifyResult; expiresAt: number }
  >();

  // ── Prometheus metrics ──────────────────────────────────────────────────

  /** Counter: total IPFS re-pin attempts (success/failure). */
  private readonly repinAttemptsCounter: client.Counter<string>;

  constructor(
    private readonly config: ConfigService,
    @Inject(PROJECT_REPOSITORY)
    private readonly projectRepo: IProjectRepository,
  ) {
    this.ipfsTimeoutMs = Number(
      this.config.get<number>('IPFS_TIMEOUT_MS', 30_000),
    );

    this.repinAttemptsCounter = new client.Counter({
      name: 'carbonchain_ipfs_repin_attempts_total',
      help: 'Total IPFS re-pin attempts during nightly refresh job',
      labelNames: ['status'],
    });
  }

  // ── IPFS upload ─────────────────────────────────────────────────────────

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

  // ── Project CRUD ─────────────────────────────────────────────────────────

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

  // ── #928: CID verification ────────────────────────────────────────────────

  /**
   * Checks whether the project's `documents_cid` is currently pinned on
   * Pinata and optionally compares a caller-supplied content hash.
   *
   * Results are cached for VERIFY_CACHE_TTL_MS per project to avoid
   * hammering the Pinata API on rapid repeated calls.
   */
  async verifyProjectCid(
    projectId: string,
    expectedHash?: string,
  ): Promise<VerifyResult> {
    const cached = this.verifyCache.get(projectId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const entity = await this.projectRepo.findById(projectId);
    if (!entity) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    const cid = entity.documentsCid;
    const cidMatch = !expectedHash || cid === expectedHash;
    let pinned = false;
    let hashOk = false;

    if (isValidIpfsCid(cid)) {
      pinned = await this.isPinned(cid);
      // hashOk: if the caller supplied an expected hash, verify it matches the
      // stored CID; if no hash supplied, we treat it as "ok" (no comparison).
      hashOk = !expectedHash ? true : cidMatch;
    }

    const result: VerifyResult = {
      projectId,
      cid,
      cidMatch,
      pinned,
      hashOk,
      checkedAt: new Date().toISOString(),
    };

    this.verifyCache.set(projectId, {
      result,
      expiresAt: Date.now() + VERIFY_CACHE_TTL_MS,
    });
    return result;
  }

  // ── #928: Nightly re-pin job ──────────────────────────────────────────────

  /**
   * Runs nightly at 03:00 UTC.
   * Iterates all projects, probes each CID, and re-pins any that are no
   * longer available. Logs a warning on failure so alerting can pick it up.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async verifyAndRepinAll(): Promise<void> {
    this.logger.log('Starting nightly IPFS pin refresh job');
    const projects = await this.projectRepo.findAll();
    let checked = 0;
    let repinned = 0;
    let failed = 0;

    for (const project of projects) {
      if (!isValidIpfsCid(project.documentsCid)) continue;
      checked++;
      try {
        const pinned = await this.isPinned(project.documentsCid);
        if (!pinned) {
          this.logger.warn(
            `CID ${project.documentsCid} for project ${project.id} is not pinned — attempting re-pin`,
          );
          await this.repin(project.documentsCid);
          repinned++;
          this.repinAttemptsCounter.labels('success').inc();
        }
      } catch (err) {
        failed++;
        this.repinAttemptsCounter.labels('failure').inc();
        this.logger.error(
          `Re-pin failed for project ${project.id} (CID ${project.documentsCid}): ` +
            `${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `IPFS pin refresh complete — checked: ${checked}, re-pinned: ${repinned}, failed: ${failed}`,
    );
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Queries Pinata's pin list API to check if a CID is currently pinned.
   * Returns false (not pinned) if the API call fails.
   */
  async isPinned(cid: string): Promise<boolean> {
    const apiKey = this.config.get<string>('IPFS_API_KEY', '');
    const secretKey = this.config.get<string>('IPFS_SECRET_KEY', '');
    const baseUrl = this.config.get<string>(
      'IPFS_API_URL',
      'https://api.pinata.cloud',
    );

    try {
      const response = await axios.get<{ count: number }>(
        `${baseUrl}/data/pinList?status=pinned&hashContains=${cid}`,
        {
          headers: {
            pinata_api_key: apiKey,
            pinata_secret_api_key: secretKey,
          },
          timeout: this.ipfsTimeoutMs,
        },
      );
      return response.data.count > 0;
    } catch {
      return false;
    }
  }

  /**
   * Calls Pinata's pin/add endpoint to re-pin an existing CID by hash.
   */
  private async repin(cid: string): Promise<void> {
    const apiKey = this.config.get<string>('IPFS_API_KEY', '');
    const secretKey = this.config.get<string>('IPFS_SECRET_KEY', '');
    const baseUrl = this.config.get<string>(
      'IPFS_API_URL',
      'https://api.pinata.cloud',
    );

    await uploadToIpfsWithRetry(() =>
      axios.post(
        `${baseUrl}/pinning/pinByHash`,
        { hashToPin: cid },
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
