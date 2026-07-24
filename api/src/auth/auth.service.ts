import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Account,
  Transaction,
  StrKey,
} from '@stellar/stellar-sdk';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { CacheService } from '../common/cache.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly networkPassphrase: string;
  private readonly serverHomeDomain: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly keypairService: StellarKeypairService,
    private readonly cache: CacheService,
  ) {
    const network = this.configService.get<string>(
      'STELLAR_NETWORK',
      'TESTNET',
    );
    this.networkPassphrase =
      network === 'PUBLIC' ? Networks.PUBLIC : Networks.TESTNET;
    this.serverHomeDomain = this.configService.get<string>(
      'HOME_DOMAIN',
      'localhost',
    );
  }

  /**
   * SEP-10 §3.1 — Build a challenge transaction.
   * The server signs a transaction with a random nonce operation (manageData)
   * and returns it for the client wallet to sign.
   * Issue #254 — Store the nonce in cache with 5-minute TTL to prevent replay attacks.
   */
  async generateChallenge(clientAccount: string): Promise<{
    transaction: string;
    network_passphrase: string;
  }> {
    if (!clientAccount || !StrKey.isValidEd25519PublicKey(clientAccount)) {
      throw new BadRequestException('Invalid Stellar account address');
    }

    const serverKeypair = this.keypairService.getAdminKeypair();

    // SEP-10 requires sequence 0 for the challenge account
    const account = new Account(serverKeypair.publicKey(), '-1');

    const nonce = Buffer.from(Keypair.random().rawPublicKey()).toString(
      'base64',
    );

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.manageData({
          name: `${this.serverHomeDomain} auth`,
          value: nonce,
          source: clientAccount,
        }),
      )
      .setTimeout(300) // 5-minute window per SEP-10
      .build();

    tx.sign(serverKeypair);

    // Store nonce in cache with 5-minute TTL (300 seconds)
    await this.cache.set(`sep10:nonce:${nonce}`, true, 300);

    return {
      transaction: tx.toEnvelope().toXDR('base64'),
      network_passphrase: this.networkPassphrase,
    };
  }

  /**
   * SEP-10 §3.3 — Verify the client-signed challenge transaction and issue a JWT.
   * Validates:
   *  1. Transaction is parseable and within time bounds
   *  2. Server signature is present and valid
   *  3. Client signature is present and valid on the manageData operation
   *  4. Nonce has not been previously used (Issue #254)
   */
  async verifyAndIssueToken(signedTransactionXdr: string): Promise<{
    access_token: string;
  }> {
    let tx: Transaction;
    try {
      tx = new Transaction(signedTransactionXdr, this.networkPassphrase);
    } catch {
      throw new BadRequestException('Invalid transaction XDR');
    }

    // Check time bounds
    const now = Math.floor(Date.now() / 1000);
    const timeBounds = tx.timeBounds;
    if (
      !timeBounds ||
      now < Number(timeBounds.minTime) ||
      now > Number(timeBounds.maxTime)
    ) {
      throw new UnauthorizedException(
        'Challenge transaction has expired or is not yet valid',
      );
    }

    // Extract client account from the first manageData operation source
    const manageDataOp = tx.operations.find((op) => op.type === 'manageData');
    if (!manageDataOp || !manageDataOp.source) {
      throw new BadRequestException(
        'Challenge transaction missing manageData operation',
      );
    }
    const clientAccount = manageDataOp.source;

    if (!StrKey.isValidEd25519PublicKey(clientAccount)) {
      throw new BadRequestException('Invalid client account in challenge');
    }

    // Verify server signature
    const serverKeypair = this.keypairService.getAdminKeypair();
    const txHash = tx.hash();
    const serverSig = tx.signatures.find((sig) => {
      try {
        return serverKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });
    if (!serverSig) {
      throw new UnauthorizedException('Server signature missing or invalid');
    }

    // Verify client signature
    const clientKeypair = Keypair.fromPublicKey(clientAccount);
    const clientSig = tx.signatures.find((sig) => {
      try {
        return clientKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });
    if (!clientSig) {
      throw new UnauthorizedException('Client signature missing or invalid');
    }

    // Issue #254 — Verify nonce freshness and prevent replay attacks
    const nonce = (manageDataOp as any).value;
    const nonceKey = `sep10:nonce:${nonce}`;
    const nonceExists = await this.cache.get<boolean>(nonceKey);
    if (!nonceExists) {
      throw new UnauthorizedException(
        'Challenge nonce not found or already used',
      );
    }

    // Delete nonce to prevent reuse
    await this.cache.del(nonceKey);

    const access_token = this.jwtService.sign({ account: clientAccount });
    this.logger.log(`Issued JWT for account: ${clientAccount}`);
    return { access_token };
  }
}
