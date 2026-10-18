/**
 * CertificateService — #929
 *
 * Generates retirement certificate PDFs in a bounded worker-thread pool.
 *
 * Problem: each request previously spawned a fresh Worker with no pool or
 * backpressure.  A burst of retirements could exhaust the thread budget and
 * stall unrelated endpoints.
 *
 * Fix:
 *  - `MAX_POOL_SIZE` concurrent workers running at any time (default: 4,
 *    configurable via CERT_POOL_SIZE env var).
 *  - A FIFO queue accepting up to `MAX_QUEUE_DEPTH` pending jobs (default: 20,
 *    configurable via CERT_QUEUE_DEPTH env var).
 *  - When the queue is full a 429 TooManyRequests is thrown immediately.
 *  - Each job has a per-certificate timeout (`CERT_TIMEOUT_MS`, default 30 s).
 *  - Prometheus gauges for pool depth and queue depth.
 */
import {
  Injectable,
  Logger,
  InternalServerErrorException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'worker_threads';
import { join } from 'path';
import { isValidIpfsCid } from '../common/ipfs-cid.util';
import client from 'prom-client';

// ── Public types ─────────────────────────────────────────────────────────────

export interface CertificateData {
  retirementId: string;
  creditId: string;
  buyer: string;
  tonnes: string;
  reason: string;
  timestamp: number;
  /** Issue #589 — vintage year of the credit (e.g. 2024). */
  vintageYear?: number;
}

/**
 * Result of generateAndPin.
 * ipfsHash is null when Pinata is unreachable (circuit-breaker open) but the
 * PDF was generated successfully — the retirement still succeeds.
 */
export interface GenerateAndPinResult {
  pdfBuffer: Buffer;
  ipfsHash: string | null;
}

// ── Internal queue item ──────────────────────────────────────────────────────

interface QueueItem {
  data: CertificateData;
  resolve: (buf: Buffer) => void;
  reject: (err: unknown) => void;
}

// ── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class CertificateService {
  private readonly logger = new Logger(CertificateService.name);
  private readonly pinataApiKey: string;
  private readonly pinataSecretKey: string;
  private readonly pinataApiUrl: string;
  private readonly ipfsTimeoutMs: number;

  /** Maximum number of worker threads running concurrently. */
  private readonly maxPoolSize: number;
  /** Maximum number of jobs waiting in the FIFO queue. */
  private readonly maxQueueDepth: number;
  /** Per-certificate generation timeout in ms. */
  private readonly certTimeoutMs: number;

  /** Number of worker threads currently executing a job. */
  private activeWorkers = 0;
  /** FIFO queue of pending PDF generation jobs. */
  private readonly queue: QueueItem[] = [];

  // ── Prometheus metrics ────────────────────────────────────────────────────

  /** Gauge: workers currently active. */
  private readonly activeWorkersGauge: client.Gauge<string>;
  /** Gauge: jobs currently waiting in the queue. */
  private readonly queueDepthGauge: client.Gauge<string>;
  /** Counter: total 429 rejections due to queue overflow. */
  private readonly queueOverflowCounter: client.Counter<string>;

  constructor(private readonly configService: ConfigService) {
    this.pinataApiKey = this.configService.get<string>('IPFS_API_KEY', '');
    this.pinataSecretKey = this.configService.get<string>(
      'IPFS_SECRET_KEY',
      '',
    );
    this.pinataApiUrl = this.configService.get<string>(
      'IPFS_API_URL',
      'https://api.pinata.cloud',
    );
    this.ipfsTimeoutMs = Number(
      this.configService.get<number>('IPFS_TIMEOUT_MS', 30_000),
    );
    this.maxPoolSize = Number(
      this.configService.get<number>('CERT_POOL_SIZE', 4),
    );
    this.maxQueueDepth = Number(
      this.configService.get<number>('CERT_QUEUE_DEPTH', 20),
    );
    this.certTimeoutMs = Number(
      this.configService.get<number>('CERT_TIMEOUT_MS', 30_000),
    );

    this.activeWorkersGauge = new client.Gauge({
      name: 'carbonchain_cert_active_workers',
      help: 'Number of certificate worker threads currently executing',
    });

    this.queueDepthGauge = new client.Gauge({
      name: 'carbonchain_cert_queue_depth',
      help: 'Number of certificate generation jobs currently waiting in the pool queue',
    });

    this.queueOverflowCounter = new client.Counter({
      name: 'carbonchain_cert_queue_overflow_total',
      help: 'Total certificate generation requests rejected because the pool queue was full (429)',
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Generates a retirement certificate PDF and pins it to IPFS via Pinata.
   *
   * Uses the bounded pool — throws 429 if the queue is full.
   */
  async generateAndPin(data: CertificateData): Promise<GenerateAndPinResult> {
    this.logger.log(
      `Generating certificate PDF for retirement ${data.retirementId}`,
    );

    const pdfBuffer = await this.buildPdf(data);

    // Circuit breaker: attempt IPFS upload but do not fail the retirement if
    // Pinata is unreachable.
    let ipfsHash: string | null = null;
    try {
      ipfsHash = await this.pinToIpfs(pdfBuffer, data.retirementId);
      this.logger.log(
        `Certificate pinned to IPFS: ${ipfsHash} for retirement ${data.retirementId}`,
      );
    } catch (err) {
      this.logger.warn(
        `Pinata upload failed for retirement ${data.retirementId} — returning null hash. ` +
          `Reason: ${(err as Error).message}`,
      );
    }

    return { pdfBuffer, ipfsHash };
  }

  /**
   * Generates a certificate PDF for a retirement without pinning to IPFS.
   * Used for direct download endpoint.
   */
  async generatePdf(data: CertificateData): Promise<Buffer> {
    this.logger.log(
      `Generating PDF for certificate download - retirement ${data.retirementId}`,
    );
    return this.buildPdf(data);
  }

  // ── Pool logic ────────────────────────────────────────────────────────────

  /**
   * Enqueues a PDF generation job.
   * - If a worker slot is free, starts immediately.
   * - If the queue has capacity, waits in line.
   * - If the queue is full, throws 429 immediately.
   */
  private buildPdf(data: CertificateData): Promise<Buffer> {
    if (
      this.activeWorkers >= this.maxPoolSize &&
      this.queue.length >= this.maxQueueDepth
    ) {
      this.queueOverflowCounter.inc();
      throw new HttpException(
        `Certificate generation queue is full (max ${this.maxQueueDepth} pending). Retry later.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return new Promise<Buffer>((resolve, reject) => {
      const item: QueueItem = { data, resolve, reject };

      if (this.activeWorkers < this.maxPoolSize) {
        this.runWorker(item);
      } else {
        this.queue.push(item);
        this.queueDepthGauge.set(this.queue.length);
      }
    });
  }

  /**
   * Spawns a single Worker for the given item.
   * When it finishes, drains the next queued item (if any).
   */
  private runWorker(item: QueueItem): void {
    this.activeWorkers++;
    this.activeWorkersGauge.set(this.activeWorkers);

    let worker: Worker;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
      this.activeWorkers--;
      this.activeWorkersGauge.set(this.activeWorkers);
      this.drainQueue();
    };

    try {
      worker = new Worker(join(__dirname, 'pdf.worker.js'), {
        workerData: item.data,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      settle(() =>
        item.reject(
          new InternalServerErrorException({
            error: 'Certificate generation failed',
            detail,
          }),
        ),
      );
      return;
    }

    // Per-certificate timeout guard.
    const timeoutHandle = setTimeout(() => {
      void worker.terminate();
      settle(() =>
        item.reject(
          new InternalServerErrorException(
            `Certificate generation timed out after ${this.certTimeoutMs}ms`,
          ),
        ),
      );
    }, this.certTimeoutMs);

    worker.once('message', (msg: { error?: string } | Buffer) => {
      clearTimeout(timeoutHandle);
      if (msg && !Buffer.isBuffer(msg) && typeof msg.error === 'string') {
        settle(() =>
          item.reject(
            new InternalServerErrorException({
              error: 'Certificate generation failed',
              detail: (msg as { error: string }).error,
            }),
          ),
        );
      } else {
        settle(() => item.resolve(msg as Buffer));
      }
    });

    worker.once('error', (err) => {
      clearTimeout(timeoutHandle);
      settle(() =>
        item.reject(
          new InternalServerErrorException({
            error: 'Certificate generation failed',
            detail: err.message,
          }),
        ),
      );
    });

    worker.once('exit', (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0) {
        settle(() =>
          item.reject(new Error(`PDF worker exited with code ${code}`)),
        );
      }
    });
  }

  /** Pulls the next item from the FIFO queue and starts a worker for it. */
  private drainQueue(): void {
    if (this.queue.length === 0) return;
    if (this.activeWorkers >= this.maxPoolSize) return;

    const next = this.queue.shift();
    if (next) {
      this.queueDepthGauge.set(this.queue.length);
      this.runWorker(next);
    }
  }

  // ── IPFS upload ───────────────────────────────────────────────────────────

  private async pinToIpfs(
    pdfBuffer: Buffer,
    retirementId: string,
  ): Promise<string> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' }),
      `retirement-certificate-${retirementId}.pdf`,
    );

    const metadata = JSON.stringify({
      name: `retirement-certificate-${retirementId}`,
      keyvalues: { retirementId },
    });
    form.append('pinataMetadata', metadata);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.ipfsTimeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.pinataApiUrl}/pinning/pinFileToIPFS`, {
        method: 'POST',
        headers: {
          pinata_api_key: this.pinataApiKey,
          pinata_secret_api_key: this.pinataSecretKey,
        },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          `Pinata upload timed out after ${this.ipfsTimeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Pinata upload failed (${response.status}): ${text}`);
    }

    const result = (await response.json()) as { IpfsHash: string };
    if (!isValidIpfsCid(result.IpfsHash)) {
      throw new Error(
        `Pinata returned an invalid IPFS CID: ${result.IpfsHash}`,
      );
    }
    return result.IpfsHash;
  }
}
