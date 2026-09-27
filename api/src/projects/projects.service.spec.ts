import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { ProjectsService } from './projects.service';
import {
  InMemoryProjectRepository,
  PROJECT_REPOSITORY,
} from './project.repository';
import { computeFileCid } from '../common/ipfs-cid.util';

const VALID_CID = computeFileCid(Buffer.from('REDD+ Project docs'));

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockConfig = {
  get: jest.fn((key: string, fallback = '') => {
    const map: Record<string, string> = {
      IPFS_API_KEY: 'test-api-key',
      IPFS_SECRET_KEY: 'test-secret',
      IPFS_API_URL: 'https://api.pinata.cloud',
    };
    return map[key] ?? fallback;
  }),
};

describe('ProjectsService', () => {
  let service: ProjectsService;
  let repo: InMemoryProjectRepository;

  beforeEach(async () => {
    repo = new InMemoryProjectRepository();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: PROJECT_REPOSITORY, useValue: repo },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
    jest.clearAllMocks();
  });

  describe('createProject', () => {
    it('creates a project without documents', async () => {
      const project = await service.createProject({
        name: 'Test Project',
        developer: 'Dev Corp',
        description: 'A test project',
        location: 'NG',
        methodology: 'VCS',
      });

      expect(project.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(project.name).toBe('Test Project');
      expect(project.documents_cid).toBe('');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('persists project to database', async () => {
      const project = await service.createProject({
        name: 'DB Test',
        developer: 'Dev',
        description: 'desc',
        location: 'US',
        methodology: 'VCS',
      });

      const stored = await repo.findById(project.id);
      expect(stored).toBeDefined();
      expect(stored!.name).toBe('DB Test');
    });

    it('uploads documents to Pinata and stores CID', async () => {
      mockedAxios.post = jest
        .fn()
        .mockResolvedValue({ data: { IpfsHash: VALID_CID } });

      const project = await service.createProject({
        name: 'REDD+ Project',
        developer: 'Green Corp',
        description: 'Reforestation',
        location: 'BR',
        methodology: 'REDD+',
        documents: { methodology: 'REDD+', area_ha: 5000 },
      });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.pinata.cloud/pinning/pinJSONToIPFS',
        { pinataContent: { methodology: 'REDD+', area_ha: 5000 } },
        expect.objectContaining({
          headers: expect.objectContaining({
            pinata_api_key: 'test-api-key',
            pinata_secret_api_key: 'test-secret',
          }),
        }),
      );
      expect(project.documents_cid).toBe(VALID_CID);
    });

    it('retries transient IPFS failures and succeeds (uploadToIpfsWithRetry wired)', async () => {
      mockedAxios.post = jest
        .fn()
        .mockRejectedValueOnce(new Error('503'))
        .mockRejectedValueOnce(new Error('503'))
        .mockResolvedValueOnce({ data: { IpfsHash: VALID_CID } });

      const project = await service.createProject({
        name: 'Retry Project',
        developer: 'Dev',
        description: 'desc',
        location: 'US',
        methodology: 'VCS',
        documents: { data: 'retry' },
      });

      expect(project.documents_cid).toBe(VALID_CID);
      expect(mockedAxios.post).toHaveBeenCalledTimes(3);
    });

    it('rejects (and does NOT persist) when IPFS upload fails', async () => {
      mockedAxios.post = jest
        .fn()
        .mockRejectedValue(new Error('Network error'));

      await expect(
        service.createProject({
          name: 'Fail IPFS',
          developer: 'Dev',
          description: 'desc',
          location: 'US',
          methodology: 'VCS',
          documents: { data: 'test' },
        }),
      ).rejects.toThrow('Network error');

      const stored = await repo.findById('fail-ipfs');
      expect(stored).toBeUndefined();
    });

    it('rejects when Pinata returns an invalid CID', async () => {
      mockedAxios.post = jest
        .fn()
        .mockResolvedValue({ data: { IpfsHash: 'not-a-cid' } });

      await expect(
        service.createProject({
          name: 'Bad CID',
          developer: 'Dev',
          description: 'desc',
          location: 'US',
          methodology: 'VCS',
          documents: { data: 'test' },
        }),
      ).rejects.toThrow(/invalid IPFS CID/);
    });
  });

  describe('getProjectAsync', () => {
    it('returns a project by id', async () => {
      const created = await service.createProject({
        name: 'P1',
        developer: 'D1',
        description: 'desc',
        location: 'US',
        methodology: 'VCS',
      });

      const found = await service.getProjectAsync(created.id);
      expect(found).toEqual(created);
    });

    it('throws NotFoundException for unknown id', async () => {
      await expect(service.getProjectAsync('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listProjects', () => {
    it('returns all projects', async () => {
      await service.createProject({
        name: 'A',
        developer: 'D',
        description: 'd',
        location: 'US',
        methodology: 'VCS',
      });
      await service.createProject({
        name: 'B',
        developer: 'D',
        description: 'd',
        location: 'BR',
        methodology: 'REDD+',
      });

      const projects = await service.listProjects();
      expect(projects).toHaveLength(2);
    });
  });
});
