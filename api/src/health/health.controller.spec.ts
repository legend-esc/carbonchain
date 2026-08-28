import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  function buildResMock() {
    const res = {
      status: jest.fn(),
      json: jest.fn(),
    };
    res.status.mockReturnValue(res);
    return res;
  }

  it('responds 200 when the aggregate status is ok', async () => {
    const healthService = {
      check: jest
        .fn()
        .mockResolvedValue({ status: 'ok', db: 'ok', stellar: 'ok' }),
    } as unknown as HealthService;
    const controller = new HealthController(healthService);
    const res = buildResMock();

    await controller.check(res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'ok',
      db: 'ok',
      stellar: 'ok',
    });
  });

  it('responds 503 when the aggregate status is error', async () => {
    const healthService = {
      check: jest
        .fn()
        .mockResolvedValue({ status: 'error', db: 'error', stellar: 'ok' }),
    } as unknown as HealthService;
    const controller = new HealthController(healthService);
    const res = buildResMock();

    await controller.check(res as any);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      db: 'error',
      stellar: 'ok',
    });
  });
});
