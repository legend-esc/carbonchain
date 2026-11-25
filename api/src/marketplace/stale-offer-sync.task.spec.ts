/**
 * Unit tests for StaleOfferSyncTask (#1308).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { StaleOfferSyncTask } from './stale-offer-sync.task';

// Mock the MarketplaceGateway module to avoid pulling in @nestjs/websockets.
jest.mock('./marketplace.gateway', () => ({
  MarketplaceGateway: class MarketplaceGateway {
    broadcastOfferExpired = jest.fn();
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MarketplaceGateway } = require('./marketplace.gateway') as {
  MarketplaceGateway: new () => { broadcastOfferExpired: jest.Mock };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMockDataSource(
  expiredRows: {
    id: string;
    seller: string;
    credit_id: string;
    expires_at: Date;
  }[] = [],
) {
  return {
    query: jest.fn().mockResolvedValue(expiredRows),
  };
}

function buildMockGateway() {
  return {
    broadcastOfferExpired: jest.fn(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StaleOfferSyncTask', () => {
  let task: StaleOfferSyncTask;
  let mockDs: ReturnType<typeof buildMockDataSource>;
  let mockGateway: ReturnType<typeof buildMockGateway>;

  async function buildModule(
    rows: {
      id: string;
      seller: string;
      credit_id: string;
      expires_at: Date;
    }[] = [],
  ) {
    mockDs = buildMockDataSource(rows);
    mockGateway = buildMockGateway();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaleOfferSyncTask,
        { provide: getDataSourceToken(), useValue: mockDs },
        { provide: MarketplaceGateway, useValue: mockGateway },
      ],
    }).compile();

    task = module.get<StaleOfferSyncTask>(StaleOfferSyncTask);
  }

  it('should be defined', async () => {
    await buildModule();
    expect(task).toBeDefined();
  });

  it('executes an UPDATE … RETURNING query against marketplace_offers', async () => {
    await buildModule();
    await task.syncStaleOffers();

    expect(mockDs.query).toHaveBeenCalledTimes(1);
    const [sql] = mockDs.query.mock.calls[0] as [string];
    expect(sql).toMatch(/UPDATE marketplace_offers/i);
    expect(sql).toMatch(/SET status = 'EXPIRED'/i);
    expect(sql).toMatch(/WHERE status = 'ACTIVE'/i);
    expect(sql).toMatch(/expires_at < NOW\(\)/i);
  });

  it('does not broadcast when no stale offers are found', async () => {
    await buildModule([]);
    await task.syncStaleOffers();

    expect(mockGateway.broadcastOfferExpired).not.toHaveBeenCalled();
  });

  it('broadcasts offer.expired for each expired offer', async () => {
    const expiredAt = new Date();
    const rows = [
      {
        id: 'offer-1',
        seller: 'GSELLER1',
        credit_id: 'cred-1',
        expires_at: expiredAt,
      },
      {
        id: 'offer-2',
        seller: 'GSELLER2',
        credit_id: 'cred-2',
        expires_at: expiredAt,
      },
    ];
    await buildModule(rows);
    await task.syncStaleOffers();

    expect(mockGateway.broadcastOfferExpired).toHaveBeenCalledTimes(2);
    expect(mockGateway.broadcastOfferExpired).toHaveBeenCalledWith(
      'offer-1',
      'GSELLER1',
    );
    expect(mockGateway.broadcastOfferExpired).toHaveBeenCalledWith(
      'offer-2',
      'GSELLER2',
    );
  });

  it('handles node-postgres nested-array result format ([rows[], rowCount])', async () => {
    const expiredAt = new Date();
    const rows = [
      {
        id: 'offer-3',
        seller: 'GSELLER3',
        credit_id: 'cred-3',
        expires_at: expiredAt,
      },
    ];
    mockDs = buildMockDataSource();
    // Simulate the [rows[], rowCount] format from node-postgres raw queries.
    mockDs.query.mockResolvedValue([rows, 1]);
    mockGateway = buildMockGateway();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaleOfferSyncTask,
        { provide: getDataSourceToken(), useValue: mockDs },
        { provide: MarketplaceGateway, useValue: mockGateway },
      ],
    }).compile();
    task = module.get<StaleOfferSyncTask>(StaleOfferSyncTask);

    await task.syncStaleOffers();

    expect(mockGateway.broadcastOfferExpired).toHaveBeenCalledWith(
      'offer-3',
      'GSELLER3',
    );
  });

  it('logs and does not throw when the DB query fails', async () => {
    await buildModule();
    mockDs.query.mockRejectedValue(new Error('DB connection lost'));

    await expect(task.syncStaleOffers()).resolves.toBeUndefined();
    expect(mockGateway.broadcastOfferExpired).not.toHaveBeenCalled();
  });
});
