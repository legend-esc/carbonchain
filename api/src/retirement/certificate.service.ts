/* eslint-disable @typescript-eslint/no-require-imports */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// pdfkit ships as a CommonJS module; use require to avoid ESM issues.

const PDFDocument = require('pdfkit') as typeof import('pdfkit');

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

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildPdf(data: CertificateData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 60, size: 'A4' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const retiredAt = new Date(data.timestamp * 1000).toUTCString();
      const tonnesDisplay = (Number(data.tonnes) / 1_000_000).toFixed(1);

      // ── Header ──────────────────────────────────────────────────────────────
      doc
        .fontSize(24)
        .font('Helvetica-Bold')
        .text('Carbon Credit Retirement Certificate', { align: 'center' });

      doc.moveDown(0.5);
      doc
        .fontSize(12)
        .font('Helvetica')
        .fillColor('#555555')
        .text('Issued by CarbonChain on the Stellar Network', {
          align: 'center',
        });

      doc.moveDown(1.5);
      doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(1);

      // ── Body ────────────────────────────────────────────────────────────────
      doc.fillColor('#000000').fontSize(12).font('Helvetica-Bold');

      const field = (label: string, value: string) => {
        doc.font('Helvetica-Bold').text(`${label}:`, { continued: true });
        doc.font('Helvetica').text(`  ${value}`);
        doc.moveDown(0.4);
      };

      field('Retirement ID', data.retirementId);
      field('Credit ID', data.creditId);
      field('Buyer', data.buyer);
      field('Tonnes Retired', `${tonnesDisplay} tonne(s)`);
      field('Reason', data.reason);
      field('Retired At', retiredAt);

      // ── Footer ──────────────────────────────────────────────────────────────
      doc.moveDown(2);
      doc.moveTo(60, doc.y).lineTo(535, doc.y).strokeColor('#cccccc').stroke();
      doc.moveDown(0.5);
      doc
        .fontSize(9)
        .fillColor('#888888')
        .text(
          'This certificate is permanently recorded on the Stellar blockchain and cannot be altered.',
          { align: 'center' },
        );

      doc.end();
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
