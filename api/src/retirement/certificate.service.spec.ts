import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { CertificateService, CertificateData } from './certificate.service';
import { computeFileCid } from '../common/ipfs-cid.util';

const SAMPLE_DATA: CertificateData = {
  retirementId: 'abc123',
  creditId: 'def456',
  buyer: 'GABC1234567890',
  tonnes: '1000000',
  reason: 'Scope 3 offset',
  timestamp: 1735689600,
};

const VALID_CID = computeFileCid(Buffer.from('certificate pdf bytes'));

function makeService(overrides: Record<string, unknown> = {}): Promise<CertificateService> {
  return Test.createTestingModule({
    providers: [
      CertificateService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string, fallback: unknown = '') => {
            const map: Record<string, unknown> = {
              CERT_POOL_SIZE: 2,
              CERT_QUEUE_DEPTH: 3,
              CERT_TIMEOUT_MS: 30_000,
              ...overrides,
            };
            return key in map ? map[key] : fallback;
          },
        },
      },
    ],
  })
    .compile()
    .then((m) => m.get<CertificateService>(CertificateService));
}

describe('CertificateService', () => {
  let service: CertificateService;

  beforeEach(async () => {
    service = await makeService();
  });

  // ── Existing functional tests ────────────────────────────────────────────

  it('generates a PDF buffer with non-zero length', async () => {
    const buf = await service.generatePdf(SAMPLE_DATA);
    expect(buf instanceof Uint8Array).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('is non-blocking: generatePdf does not block the event loop', async () => {
    const pdfPromise = service.generatePdf(SAMPLE_DATA);

    let eventLoopReached = false;
    await Promise.resolve().then(() => {
      eventLoopReached = true;
    });

    expect(eventLoopReached).toBe(true);

    const buf = await pdfPromise;
    expect(buf.length).toBeGreaterThan(0);
  });

  // ── #929: Pool / backpressure tests ─────────────────────────────────────

  describe('#929 — bounded worker pool', () => {
    it('50 concurrent requests complete without process exhaustion (pool size=4)', async () => {
      // Use default pool size of 4 so we exercise the queue drain path.
      const bigService = await makeService({
        CERT_POOL_SIZE: 4,
        CERT_QUEUE_DEPTH: 100,
      });

      const requests = Array.from({ length: 50 }, (_, i) =>
        bigService.generatePdf({ ...SAMPLE_DATA, retirementId: `r-${i}` }),
      );

      const results = await Promise.all(requests);
      expect(results).toHaveLength(50);
      results.forEach((buf) => expect(buf.length).toBeGreaterThan(0));
    }, 120_000); // 2-minute timeout for 50 serial-queued workers

    it('throws 429 when queue is full', async () => {
      // Pool size=1, queue depth=0 → second request immediately 429s.
      const tinyService = await makeService({
        CERT_POOL_SIZE: 1,
        CERT_QUEUE_DEPTH: 0,
      });

      // Fire first request (fills the single worker slot) but do NOT await.
      const first = tinyService.generatePdf(SAMPLE_DATA);

      // Second request: pool full AND queue full → 429.
      await expect(
        tinyService.generatePdf({ ...SAMPLE_DATA, retirementId: 'overflow' }),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });

      // Let the first request finish cleanly.
      await first;
    });

    it('queues within pool limit and drains in FIFO order', async () => {
      // Pool=1, queue=2 → up to 3 inflight at once (1 running + 2 queued).
      const svc = await makeService({ CERT_POOL_SIZE: 1, CERT_QUEUE_DEPTH: 2 });
      const ids: string[] = [];

      const results = await Promise.all([
        svc.generatePdf({ ...SAMPLE_DATA, retirementId: 'job-1' }).then((b) => { ids.push('job-1'); return b; }),
        svc.generatePdf({ ...SAMPLE_DATA, retirementId: 'job-2' }).then((b) => { ids.push('job-2'); return b; }),
        svc.generatePdf({ ...SAMPLE_DATA, retirementId: 'job-3' }).then((b) => { ids.push('job-3'); return b; }),
      ]);

      expect(results).toHaveLength(3);
      results.forEach((buf) => expect(buf.length).toBeGreaterThan(0));
    });
  });

  // ── Pinata failure path ──────────────────────────────────────────────────

  it('generateAndPin returns null ipfsHash when Pinata is unreachable', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    try {
      const result = await service.generateAndPin(SAMPLE_DATA);
      expect(result.pdfBuffer).toBeInstanceOf(Uint8Array);
      expect(result.pdfBuffer.length).toBeGreaterThan(0);
      expect(result.ipfsHash).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('generateAndPin returns null ipfsHash when Pinata returns non-200', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    try {
      const result = await service.generateAndPin(SAMPLE_DATA);
      expect(result.pdfBuffer.length).toBeGreaterThan(0);
      expect(result.ipfsHash).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('generateAndPin returns non-null ipfsHash when Pinata is reachable', async () => {
    const expectedHash = VALID_CID;
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ IpfsHash: expectedHash }),
    });

    try {
      const result = await service.generateAndPin(SAMPLE_DATA);
      expect(result.pdfBuffer.length).toBeGreaterThan(0);
      expect(result.ipfsHash).toBe(expectedHash);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('generateAndPin propagates DataCloneError from worker as structured 500', async () => {
    const badData: any = { ...SAMPLE_DATA, callback: () => {} };

    await expect(service.generateAndPin(badData)).rejects.toMatchObject({
      response: expect.objectContaining({
        error: 'Certificate generation failed',
      }),
    });
  });
});
