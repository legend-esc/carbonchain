import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreditsService } from '../credits/credits.service';
import { VerifiersService } from '../verifiers/verifiers.service';
import { RetirementService } from '../retirement/retirement.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { CreditStatus } from '../../../shared';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { AdminAuditEntity } from './admin-audit.entity';

export interface AdminStats {
  totalCredits: number;
  totalRetirements: number;
  activeVerifiers: number;
  paused: boolean;
}

export interface VerifierCapabilities {
  methodologies?: string[];
  geographies?: string[];
}

/** Context injected by the controller so audit rows capture HTTP metadata. */
export interface AuditContext {
  actor: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface AuditQueryOptions {
  actor?: string;
  action?: string;
  from?: Date;
  to?: Date;
  /** Page size (max 200, default 50). */
  limit?: number;
  /** Offset for pagination (default 0). */
  offset?: number;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly creditRegistryContractId: string;

  constructor(
    private readonly creditsService: CreditsService,
    private readonly verifiersService: VerifiersService,
    private readonly configService: ConfigService,
    private readonly stellarService: StellarService,
    private readonly keypairService: StellarKeypairService,
    @InjectRepository(AdminAuditEntity)
    private readonly auditRepo: Repository<AdminAuditEntity>,
    private readonly retirementService: RetirementService,
  ) {
    this.creditRegistryContractId =
      this.configService.get<string>('CREDIT_REGISTRY_CONTRACT_ID') || '';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Writes an immutable audit row. Non-fatal: a logging failure must never
   * surface to the caller as an error — the primary side effect already
   * succeeded.
   */
  private async writeAudit(
    ctx: AuditContext,
    action: string,
    target: string | null,
    beforeState: Record<string, unknown> | null,
    afterState: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      const row = this.auditRepo.create({
        actor: ctx.actor,
        action,
        target,
        beforeState,
        afterState,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId ?? null,
      });
      await this.auditRepo.save(row);
    } catch (err) {
      this.logger.error(
        `Failed to write audit row (action=${action}): ${(err as Error).message}`,
      );
    }
  }

  async getStats(): Promise<AdminStats> {
    const verifiers = await this.verifiersService.listVerifiers();
    let paused = false;
    try {
      paused = await this.getContractPaused();
    } catch {
      // Non-fatal — default to false if contract call fails.
    }
    const [totalCredits, retirements] = await Promise.all([
      this.creditsService.getCreditCount(),
      this.retirementService.listRetirements(1, 1),
    ]);
    return {
      totalCredits: 0,
      totalRetirements: 0,
      totalCredits,
      totalRetirements: retirements.total,
      activeVerifiers: verifiers.length,
      paused,
    };
  }

  private async getContractPaused(): Promise<boolean> {
    if (!this.creditRegistryContractId) return false;
    const result = await this.stellarService.readContract(
      this.creditRegistryContractId,
      'paused',
      [],
    );
    return result ? (scValToNative(result) as boolean) : false;
  }

  async pauseContract(
    ctx: AuditContext = { actor: 'system' },
  ): Promise<{ paused: boolean }> {
    const admin = this.keypairService.getAdminKeypair();
    const args = [nativeToScVal(admin.publicKey(), { type: 'address' })];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'pause',
      args,
      admin,
    );
    this.logger.log('Contract paused via credit_registry.pause()');
    await this.writeAudit(
      ctx,
      'pause_contract',
      this.creditRegistryContractId,
      { paused: false },
      { paused: true },
    );
    return { paused: true };
  }

  async unpauseContract(
    ctx: AuditContext = { actor: 'system' },
  ): Promise<{ paused: boolean }> {
    const admin = this.keypairService.getAdminKeypair();
    const args = [nativeToScVal(admin.publicKey(), { type: 'address' })];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'unpause',
      args,
      admin,
    );
    this.logger.log('Contract unpaused via credit_registry.unpause()');
    await this.writeAudit(
      ctx,
      'unpause_contract',
      this.creditRegistryContractId,
      { paused: true },
      { paused: false },
    );
    return { paused: false };
  }

  async registerVerifier(
    address: string,
    ctx: AuditContext = { actor: 'system' },
  ): Promise<{ registered: boolean; address: string }> {
    await this.writeAudit(
      ctx,
      'register_verifier',
      address,
      null,
      { registered: true, address },
    );
    return { registered: true, address };
  }

  async suspendVerifier(
    id: string,
    ctx: AuditContext = { actor: 'system' },
  ): Promise<{ suspended: boolean }> {
    const verifier = await this.verifiersService.getVerifier(id);
    await this.writeAudit(
      ctx,
      'suspend_verifier',
      id,
      { verifier },
      { suspended: true },
    );
    void address;
    // No `register_verifier` contract/DB call exists yet — see verifiers.service.ts.
    // Returning a fake success here would silently mislead admin tooling.
    throw new NotImplementedException(
      'registerVerifier is not implemented: no backing contract/DB call exists yet',
    );
  }

  async suspendVerifier(id: string): Promise<{ suspended: boolean }> {
    await this.verifiersService.getVerifier(id);
    this.logger.log(`Verifier ${id} suspended by admin`);
    return { suspended: true };
  }

  async configureVerifier(
    id: string,
    capabilities: VerifierCapabilities,
    ctx: AuditContext = { actor: 'system' },
  ): Promise<{ configured: boolean; verifierId: string }> {
    const verifier = await this.verifiersService.getVerifier(id);
    await this.writeAudit(
      ctx,
      'configure_verifier',
      id,
      { verifier },
      { configured: true, verifierId: id, capabilities },
    );
    return { configured: true, verifierId: id };
    void _capabilities;
    await this.verifiersService.getVerifier(id);
    // No `configure_verifier` contract/DB call exists yet.
    throw new NotImplementedException(
      'configureVerifier is not implemented: no backing contract/DB call exists yet',
    );
  }

  async flagCredit(
    id: string,
    ctx: AuditContext = { actor: 'system' },
  ): Promise<{ flagged: boolean; creditId: string; status: CreditStatus }> {
    const credit = await this.creditsService.getCredit(id);
    await this.writeAudit(
      ctx,
      'flag_credit',
      id,
      { status: (credit as { status?: unknown })?.status ?? null },
      { flagged: true, creditId: id, status: CreditStatus.Flagged },
    );
    await this.creditsService.getCredit(id);
    this.logger.log(`Credit ${id} flagged by admin`);
    return { flagged: true, creditId: id, status: CreditStatus.Flagged };
  }

  /**
   * Set the minimum stake required to register as a verifier.
   */
  async setMinStake(
    amount: string,
    nonce: string,
    ctx: AuditContext = { actor: 'system' },
  ): Promise<{ minStake: string }> {
    const admin = this.keypairService.getAdminKeypair();
    const args = [
      nativeToScVal(admin.publicKey(), { type: 'address' }),
      nativeToScVal(BigInt(amount), { type: 'i128' }),
      nativeToScVal(BigInt(nonce), { type: 'u64' }),
    ];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'set_min_stake',
      args,
      admin,
    );
    this.logger.log(`Minimum stake updated to ${amount} stroops`);
    await this.writeAudit(
      ctx,
      'set_min_stake',
      this.creditRegistryContractId,
      null,
      { minStake: amount },
    );
    return { minStake: amount };
  }

  /**
   * Slash 10% of a verifier's locked stake.
   */
  async slashVerifier(
    verifierAddress: string,
    creditId: string,
    nonce: string,
    ctx: AuditContext = { actor: 'system' },
  ): Promise<{ slashed: boolean; verifier: string; creditId: string }> {
    const admin = this.keypairService.getAdminKeypair();
    const args = [
      nativeToScVal(admin.publicKey(), { type: 'address' }),
      nativeToScVal(verifierAddress, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(BigInt(nonce), { type: 'u64' }),
    ];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'slash_verifier',
      args,
      admin,
    );
    this.logger.log(
      `Slashed verifier ${verifierAddress} for credit ${creditId}`,
    );
    await this.writeAudit(
      ctx,
      'slash_verifier',
      verifierAddress,
      null,
      { slashed: true, verifier: verifierAddress, creditId },
    );
    return { slashed: true, verifier: verifierAddress, creditId };
  }

  /**
   * Register a new carbon credit methodology.
   */
  registerMethodology(
    name: string,
    description: string,
    ctx: AuditContext = { actor: 'system' },
  ): { registered: boolean; name: string; description: string } {
    // Fire-and-forget — sync method; audit write is async but non-blocking
    void this.writeAudit(
      ctx,
      'register_methodology',
      name,
      null,
      { registered: true, name, description },
    );
    this.logger.log(`Registering methodology: ${name}`);
    return { registered: true, name, description };
  }

  async getNonce(address: string): Promise<{ address: string; nonce: number }> {
    this.logger.log(`Fetching on-chain nonce for ${address}`);
    try {
      const args = [nativeToScVal(address, { type: 'address' })];
      const retval = await this.stellarService.readContract(
        this.creditRegistryContractId,
        'get_nonce',
        args,
      );
      const nonce: bigint = retval ? (scValToNative(retval) as bigint) : 0n;
      return { address, nonce: Number(nonce) };
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch nonce for ${address}: ${(error as Error).message}`,
      );
      return { address, nonce: 0 };
    }
  }

  async setRequiredApprovals(
    threshold: number,
    ctx: AuditContext = { actor: 'system' },
  ): Promise<{ requiredApprovals: number }> {
    this.logger.log(`Setting required approvals to ${threshold}`);
    const admin = this.keypairService.getAdminKeypair();
    const nonceRetval = await this.stellarService.readContract(
      this.creditRegistryContractId,
      'get_nonce',
      [nativeToScVal(admin.publicKey(), { type: 'address' })],
    );
    const nonce: bigint = nonceRetval
      ? (scValToNative(nonceRetval) as bigint)
      : 0n;

    const args = [
      nativeToScVal(admin.publicKey(), { type: 'address' }),
      nativeToScVal(threshold, { type: 'u32' }),
      nativeToScVal(nonce, { type: 'u64' }),
    ];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'set_required_approvals',
      args,
      admin,
    );
    await this.writeAudit(
      ctx,
      'set_required_approvals',
      this.creditRegistryContractId,
      null,
      { requiredApprovals: threshold },
    );
    return { requiredApprovals: threshold };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Audit read — Issue #934: GET /admin/audit (paginated + filterable)
  // ─────────────────────────────────────────────────────────────────────────

  async getAuditLog(
    opts: AuditQueryOptions = {},
  ): Promise<{ rows: AdminAuditEntity[]; total: number }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const qb = this.auditRepo
      .createQueryBuilder('a')
      .orderBy('a.createdAt', 'DESC')
      .take(limit)
      .skip(offset);

    if (opts.actor) {
      qb.andWhere('a.actor = :actor', { actor: opts.actor });
    }
    if (opts.action) {
      qb.andWhere('a.action = :action', { action: opts.action });
    }
    if (opts.from) {
      qb.andWhere('a.createdAt >= :from', { from: opts.from });
    }
    if (opts.to) {
      qb.andWhere('a.createdAt <= :to', { to: opts.to });
    }

    const [rows, total] = await qb.getManyAndCount();
    return { rows, total };
  }
}
