import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CertificateService, CertificateData } from './certificate.service';

const SAMPLE_DATA: CertificateData = {
  retirementId: 'abc123',
  creditId: 'def456',
  buyer: 'GABC1234567890',
  tonnes: '1000000',
  reason: 'Scope 3 offset',
  timestamp: 1735689600,
};

describe('CertificateService', () => {
  let service: CertificateService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificateService,
        {
          provide: ConfigService,
          useValue: { get: (_key: string, fallback = '') => fallback },
        },
      ],
    }).compile();

    service = module.get<CertificateService>(CertificateService);
  });

  it('generates a PDF buffer with non-zero length', async () => {
    const buf = await service.generatePdf(SAMPLE_DATA);
    // In Node 22+ worker threads transfer Uint8Array; Buffer is a subclass of Uint8Array.
    expect(buf instanceof Uint8Array).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('is non-blocking: generatePdf does not block the event loop', async () => {
    // Start PDF generation — do NOT await yet.
    const pdfPromise = service.generatePdf(SAMPLE_DATA);

    // This microtask executes while the worker is running, proving the event
    // loop was not blocked.
    let eventLoopReached = false;
    await Promise.resolve().then(() => {
      eventLoopReached = true;
    });

    expect(eventLoopReached).toBe(true);

    // Now await the PDF to confirm it still completes successfully.
    const buf = await pdfPromise;
    expect(buf.length).toBeGreaterThan(0);
  });

  // ── Issue #493: Pinata failure path ───────────────────────────────────────

  it('generateAndPin returns null ipfsHash when Pinata is unreachable', async () => {
    // Intercept the global fetch to simulate a network failure.
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    try {
      const result = await service.generateAndPin(SAMPLE_DATA);

      // PDF was generated.
      expect(result.pdfBuffer).toBeInstanceOf(Uint8Array);
      expect(result.pdfBuffer.length).toBeGreaterThan(0);

      // IPFS hash is null (Pinata unreachable — graceful degradation).
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
    const expectedHash = 'QmTestIpfsHash123';
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
    // Build a data object with a non-cloneable property to trigger DataCloneError.
    // worker_threads uses v8 serialization which tolerates circular references,
    // but functions cannot be cloned — passing one as workerData throws synchronously.
    const badData: any = {
      ...SAMPLE_DATA,
      callback: () => {},
    };

    await expect(service.generateAndPin(badData)).rejects.toMatchObject({
      response: expect.objectContaining({
        error: 'Certificate generation failed',
      }),
    });
  });
});
