import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import axios from 'axios';
import { ProjectsService } from './projects.service';

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: ConfigService, useValue: mockConfig },
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

      expect(project.id).toMatch(/^proj_/);
      expect(project.name).toBe('Test Project');
      expect(project.documents_cid).toBe('');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('uploads documents to Pinata and stores CID', async () => {
      mockedAxios.post = jest
        .fn()
        .mockResolvedValue({ data: { IpfsHash: 'bafybeitest123' } });

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
      expect(project.documents_cid).toBe('bafybeitest123');
    });

    it('throws when Pinata upload fails', async () => {
      mockedAxios.post = jest
        .fn()
        .mockRejectedValue(new Error('Network error'));

      await expect(
        service.createProject({
          name: 'Fail Project',
          developer: 'Dev',
          description: 'desc',
          location: 'US',
          methodology: 'VCS',
          documents: { data: 'test' },
        }),
      ).rejects.toThrow('Network error');
    });
  });

  describe('getProject', () => {
    it('returns a project by id', async () => {
      const created = await service.createProject({
        name: 'P1',
        developer: 'D1',
        description: 'desc',
        location: 'US',
        methodology: 'VCS',
      });

      const found = service.getProject(created.id);
      expect(found).toEqual(created);
    });

    it('throws NotFoundException for unknown id', () => {
      expect(() => service.getProject('nonexistent')).toThrow(
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

      expect(service.listProjects()).toHaveLength(2);
    });
  });
});
