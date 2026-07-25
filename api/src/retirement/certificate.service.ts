/* eslint-disable @typescript-eslint/no-require-imports */
import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'worker_threads';
import { join } from 'path';

export interface CertificateData {
  retirementId: string;
  creditId: string;
  buyer: string;
  tonnes: string;
  reason: string;
  timestamp: number;
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

@Injectable()
export class CertificateService {
  private readonly logger = new Logger(CertificateService.name);
  private readonly pinataApiKey: string;
  private readonly pinataSecretKey: string;
  private readonly pinataApiUrl: string;

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
  }

  /**
   * Generates a retirement certificate PDF and pins it to IPFS via Pinata.
   *
   * Issue #493 fixes:
   *  - DataCloneError during Worker construction is caught and wrapped in a
   *    structured InternalServerErrorException.
   *  - Pinata failures are circuit-broken: if the upload fails the method
   *    returns { pdfBuffer, ipfsHash: null } instead of throwing, so the
   *    retirement flow can still succeed with a null certificate hash.
   *
   * @returns { pdfBuffer, ipfsHash } — ipfsHash is null when Pinata is unreachable.
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
      // Return partial success: PDF was generated, IPFS upload failed.
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

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Runs pdfkit in a worker thread so the event loop is never blocked.
   *
   * Issue #493 fix: wraps Worker construction in try/catch to handle
   * DataCloneError that occurs when workerData contains non-cloneable values
   * (e.g. circular references from unexpected upstream data).
   */
  private buildPdf(data: CertificateData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(join(__dirname, 'pdf.worker.js'), {
          workerData: data,
        });
      } catch (err) {
        // DataCloneError (or any synchronous spawn error) — wrap and reject.
        const detail =
          err instanceof Error ? err.message : String(err);
        reject(
          new InternalServerErrorException({
            error: 'Certificate generation failed',
            detail,
          }),
        );
        return;
      }

      worker.once('message', (msg: { error?: string } | Buffer) => {
        // Issue #493 fix: pdf.worker.js may post { error: '...' } instead of
        // throwing, so the parent can reject the promise cleanly.
        if (msg && !Buffer.isBuffer(msg) && typeof (msg as any).error === 'string') {
          reject(
            new InternalServerErrorException({
              error: 'Certificate generation failed',
              detail: (msg as { error: string }).error,
            }),
          );
        } else {
          resolve(msg as Buffer);
        }
      });

      worker.once('error', (err) => {
        reject(
          new InternalServerErrorException({
            error: 'Certificate generation failed',
            detail: err.message,
          }),
        );
      });

      worker.once('exit', (code) => {
        if (code !== 0) {
          reject(
            new InternalServerErrorException({
              error: 'Certificate generation failed',
              detail: `PDF worker exited with code ${code}`,
            }),
          );
        }
      });
    });
  }

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

    const response = await fetch(`${this.pinataApiUrl}/pinning/pinFileToIPFS`, {
      method: 'POST',
      headers: {
        pinata_api_key: this.pinataApiKey,
        pinata_secret_api_key: this.pinataSecretKey,
      },
      body: form,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Pinata upload failed (${response.status}): ${text}`);
    }

    const result = (await response.json()) as { IpfsHash: string };
    return result.IpfsHash;
  }
}
