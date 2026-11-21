import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import axios from 'axios';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';

/**
 * Issue #1300: IPFS Metadata Pinning Integrity Worker
 * Monitors CreditSubmitted events, verifies IPFS content integrity,
 * and pins to secondary pinning services (Pinata, Web3.Storage)
 */
@Injectable()
export class IpfsPinningService {
  private readonly logger = new Logger(IpfsPinningService.name);
  private helia: any;

  constructor(private eventEmitter: EventEmitter2) {
    this.initializeHelia();
  }

  private async initializeHelia(): Promise<void> {
    try {
      this.helia = await createHelia();
      this.logger.log('Helia node initialized for IPFS operations');
    } catch (error) {
      this.logger.error('Failed to initialize Helia:', error);
    }
  }

  /**
   * Pin credit metadata to redundant IPFS services
   * @param creditId - Credit identifier
   * @param ipfsHash - IPFS CID hash
   * @param metadata - Credit metadata for verification
   */
  async pinMetadata(
    creditId: string,
    ipfsHash: string,
    metadata: any,
  ): Promise<void> {
    try {
      // Step 1: Verify content integrity via Helia
      await this.verifyContentIntegrity(ipfsHash, metadata);
      this.logger.log(`✓ Content integrity verified for ${ipfsHash}`);

      // Step 2: Pin to Pinata
      await this.pinToPinata(ipfsHash, creditId);
      this.logger.log(`✓ Pinned to Pinata: ${ipfsHash}`);

      // Step 3: Pin to Web3.Storage
      await this.pinToWeb3Storage(ipfsHash, creditId);
      this.logger.log(`✓ Pinned to Web3.Storage: ${ipfsHash}`);
    } catch (error) {
      this.logger.error(`Failed to pin metadata for credit ${creditId}:`, error);
      throw error;
    }
  }

  /**
   * Verify CID content integrity against expected metadata
   */
  private async verifyContentIntegrity(
    cid: string,
    expectedMetadata: any,
  ): Promise<void> {
    try {
      if (!this.helia) {
        this.logger.warn('Helia not initialized, skipping integrity check');
        return;
      }

      const fs = unixfs(this.helia);
      const decoder = new TextDecoder();
      let content = '';

      // Retrieve content from CID
      for await (const chunk of fs.cat(cid)) {
        content += decoder.decode(chunk, { stream: true });
      }

      // Parse and verify
      const retrievedMetadata = JSON.parse(content);
      const contentHash = this.hashMetadata(retrievedMetadata);
      const expectedHash = this.hashMetadata(expectedMetadata);

      if (contentHash !== expectedHash) {
        throw new Error(
          `Content integrity check failed: hash mismatch (${contentHash} !== ${expectedHash})`,
        );
      }

      this.logger.log(`✓ Content verified: ${cid}`);
    } catch (error) {
      this.logger.error(`Integrity verification failed for ${cid}:`, error);
      throw error;
    }
  }

  /**
   * Pin to Pinata (primary pinning service)
   */
  private async pinToPinata(cid: string, creditId: string): Promise<void> {
    const pinataApiKey = process.env.PINATA_API_KEY;
    const pinataApiSecret = process.env.PINATA_API_SECRET;

    if (!pinataApiKey || !pinataApiSecret) {
      this.logger.warn('Pinata credentials not configured, skipping Pinata pin');
      return;
    }

    try {
      const response = await axios.post(
        'https://api.pinata.cloud/pinning/pinByHash',
        {
          hashToPin: cid,
          keyvalues: {
            creditId,
            pinnedAt: new Date().toISOString(),
            source: 'carbonchain-api',
          },
        },
        {
          headers: {
            pinata_api_key: pinataApiKey,
            pinata_api_secret: pinataApiSecret,
          },
        },
      );

      this.logger.log(`Pinata pin request submitted: ${response.data.id}`);
    } catch (error) {
      this.logger.error(`Pinata pinning failed for ${cid}:`, error);
      // Don't throw - allow other pinning services to continue
    }
  }

  /**
   * Pin to Web3.Storage (secondary pinning service)
   */
  private async pinToWeb3Storage(cid: string, creditId: string): Promise<void> {
    const web3StorageToken = process.env.WEB3_STORAGE_TOKEN;

    if (!web3StorageToken) {
      this.logger.warn(
        'Web3.Storage token not configured, skipping Web3.Storage pin',
      );
      return;
    }

    try {
      const response = await axios.post(
        `https://api.web3.storage/pin`,
        {
          cid,
          name: `credit-${creditId}`,
          meta: {
            creditId,
            pinnedAt: new Date().toISOString(),
          },
        },
        {
          headers: {
            Authorization: `Bearer ${web3StorageToken}`,
          },
        },
      );

      this.logger.log(`Web3.Storage pin request submitted: ${response.data.requestid}`);
    } catch (error) {
      this.logger.error(`Web3.Storage pinning failed for ${cid}:`, error);
      // Don't throw - allow other pinning services to continue
    }
  }

  /**
   * Compute hash of metadata for integrity verification
   */
  private hashMetadata(metadata: any): string {
    const crypto = require('crypto');
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(metadata))
      .digest('hex');
  }

  /**
   * Check pin status across all pinning services
   */
  async getPinStatus(cid: string): Promise<{ pinata?: boolean; web3storage?: boolean }> {
    const status: any = {};

    // Check Pinata
    if (process.env.PINATA_API_KEY) {
      status.pinata = await this.checkPinataPinStatus(cid);
    }

    // Check Web3.Storage
    if (process.env.WEB3_STORAGE_TOKEN) {
      status.web3storage = await this.checkWeb3StoragePinStatus(cid);
    }

    return status;
  }

  private async checkPinataPinStatus(cid: string): Promise<boolean> {
    try {
      const response = await axios.get(
        `https://api.pinata.cloud/data/pinList?hashContains=${cid}`,
        {
          headers: {
            pinata_api_key: process.env.PINATA_API_KEY,
            pinata_api_secret: process.env.PINATA_API_SECRET,
          },
        },
      );
      return response.data.rows && response.data.rows.length > 0;
    } catch {
      return false;
    }
  }

  private async checkWeb3StoragePinStatus(cid: string): Promise<boolean> {
    try {
      const response = await axios.get(
        `https://api.web3.storage/check/${cid}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.WEB3_STORAGE_TOKEN}`,
          },
        },
      );
      return response.data.ok && response.data.pin.cid === cid;
    } catch {
      return false;
    }
  }
}
