import { Test, TestingModule } from '@nestjs/testing';
import { HealthService, PG_POOL } from './health.service';
import { StellarService } from '../stellar/stellar.service';

describe('HealthService', () => {
  let service: HealthService;
  let pool: { query: jest.Mock };
  let stellarService: { getSorobanRpcServer: jest.Mock };

  beforeEach(async () => {
    pool = { query: jest.fn() };
    stellarService = { getSorobanRpcServer: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: PG_POOL, useValue: pool },
        { provide: StellarService, useValue: stellarService },
      ],
    }).compile();

    service = module.get(HealthService);
  });

  it('reports ok for all checks when db and stellar are reachable', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    stellarService.getSorobanRpcServer.mockReturnValue({
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    });

    expect(await service.check()).toEqual({
      status: 'ok',
      db: 'ok',
      stellar: 'ok',
    });
  });

  it('reports db error and overall error when Postgres is unreachable', async () => {
    pool.query.mockRejectedValue(new Error('connection refused'));
    stellarService.getSorobanRpcServer.mockReturnValue({
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    });

    expect(await service.check()).toEqual({
      status: 'error',
      db: 'error',
      stellar: 'ok',
    });
  });

  it('reports stellar error and overall error when Soroban RPC is unreachable', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    stellarService.getSorobanRpcServer.mockReturnValue({
      getHealth: jest.fn().mockRejectedValue(new Error('timeout')),
    });

    expect(await service.check()).toEqual({
      status: 'error',
      db: 'ok',
      stellar: 'error',
    });
  });
});
