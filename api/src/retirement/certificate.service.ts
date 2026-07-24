/* eslint-disable @typescript-eslint/no-require-imports */
import { Injectable, Logger } from '@nestjs/common';
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
   * Returns the IPFS CID of the uploaded PDF.
   */
  async generateAndPin(data: CertificateData): Promise<string> {
    this.logger.log(
      `Generating certificate PDF for retirement ${data.retirementId}`,
    );

    const pdfBuffer = await this.buildPdf(data);
    const ipfsHash = await this.pinToIpfs(pdfBuffer, data.retirementId);

    this.logger.log(
      `Certificate pinned to IPFS: ${ipfsHash} for retirement ${data.retirementId}`,
    );

    return ipfsHash;
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
   */
  private buildPdf(data: CertificateData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'pdf.worker.js'), {
        workerData: data,
      });
      worker.once('message', (buf: Buffer) => resolve(buf));
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`PDF worker exited with code ${code}`));
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
