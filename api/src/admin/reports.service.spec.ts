import { ReportsService } from './reports.service';
import { RetirementService } from '../retirement/retirement.service';
import { ForbiddenException } from '@nestjs/common';

const makeRetirementServiceStub = (): jest.Mocked<RetirementService> =>
  ({
    listRetirements: jest.fn(),
  } as unknown as jest.Mocked<RetirementService>);

const SAMPLE_RECORD = {
  id: 'abc123',
  credit_id: 'proj-001',
  buyer: 'GBUYER123',
  tonnes_retired: '1000000', // 1.0 tonne
  reason: 'offset',
  retired_at: 1700000000,
  tx_hash: 'txhash001',
};

async function collectLines(gen: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('ReportsService', () => {
  let service: ReportsService;
  let retirementService: jest.Mocked<RetirementService>;

  beforeEach(() => {
    retirementService = makeRetirementServiceStub();
    service = new ReportsService(retirementService);
  });

  it('throws 403 for non-admin/auditor roles', async () => {
    const gen = service.generateComplianceCsv('user');
    await expect(gen.next()).rejects.toThrow(ForbiddenException);
  });

  it('allows admin role', async () => {
    retirementService.listRetirements.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 500,
    });
    const gen = service.generateComplianceCsv('admin');
    await expect(gen.next()).resolves.not.toThrow();
  });

  it('allows auditor role', async () => {
    retirementService.listRetirements.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 500,
    });
    const gen = service.generateComplianceCsv('auditor');
    await expect(gen.next()).resolves.not.toThrow();
  });

  it('emits CSV header as first line', async () => {
    retirementService.listRetirements.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 500,
    });
    const lines = await collectLines(service.generateComplianceCsv('admin'));
    expect(lines[0]).toContain('Date');
    expect(lines[0]).toContain('Serial Number');
    expect(lines[0]).toContain('Retirement Beneficiary');
  });

  it('formats ISO 8601 date and 0.1-resolution tonnes', async () => {
    retirementService.listRetirements
      .mockResolvedValueOnce({ data: [SAMPLE_RECORD], total: 1, page: 1, limit: 500 })
      .mockResolvedValue({ data: [], total: 0, page: 2, limit: 500 });

    const lines = await collectLines(service.generateComplianceCsv('admin'));
    const dataLine = lines[1];
    expect(dataLine).toContain('2023-11-14'); // retired_at 1700000000 ≈ 2023-11-14
    expect(dataLine).toContain('1.0');         // 1000000 / 1_000_000 = 1.0
    expect(dataLine).toContain('GBUYER123');
  });

  it('streams in pages and stops when page is not full', async () => {
    retirementService.listRetirements
      .mockResolvedValueOnce({ data: [SAMPLE_RECORD], total: 1, page: 1, limit: 500 })
      .mockResolvedValue({ data: [], total: 0, page: 2, limit: 500 });

    await collectLines(service.generateComplianceCsv('admin'));
    expect(retirementService.listRetirements).toHaveBeenCalledTimes(2);
  });

  it('escapes fields with commas in CSV output', async () => {
    const recordWithComma = {
      ...SAMPLE_RECORD,
      buyer: 'Buyer, Inc.',
    };
    retirementService.listRetirements
      .mockResolvedValueOnce({ data: [recordWithComma], total: 1, page: 1, limit: 500 })
      .mockResolvedValue({ data: [], total: 0, page: 2, limit: 500 });

    const lines = await collectLines(service.generateComplianceCsv('admin'));
    expect(lines[1]).toContain('"Buyer, Inc."');
  });
});
