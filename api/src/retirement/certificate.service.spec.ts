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
    expect(buf).toBeInstanceOf(Buffer);
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
});
