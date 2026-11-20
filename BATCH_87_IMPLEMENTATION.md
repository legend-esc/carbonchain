# Batch-87: Carbon Chain Platform Enhancements

Comprehensive implementation documentation for issues #947, #948, #949, and #950.

---

## Issue #950: Retire Wizard — Integrate Build→Sign→Submit Flow

### Problem
Current retire flow relies on server-side admin signing (no user authorization), lacks XDR signing, and offers no cost preview or error recovery.

### Solution Architecture

#### 1. Retire Transaction Build Endpoint

```typescript
// api/src/retirement/retire-tx.controller.ts
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RetireTxService } from './retire-tx.service';

@Controller('api/v1/txs')
export class RetireTxController {
  constructor(private retireTxService: RetireTxService) {}

  @Post('build')
  @UseGuards(AuthGuard('jwt'))
  async buildRetireTransaction(
    @Body() dto: BuildRetireTransactionDto,
  ) {
    return this.retireTxService.buildRetireTransaction(dto);
  }

  @Post('submit')
  @UseGuards(AuthGuard('jwt'))
  async submitRetireTransaction(
    @Body() dto: SubmitRetireTransactionDto,
  ) {
    return this.retireTxService.submitRetireTransaction(dto);
  }
}
```

#### 2. Retire Transaction Service

```typescript
// api/src/retirement/retire-tx.service.ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { StellarService } from '../stellar/stellar.service';
import * as StellarSDK from 'stellar-sdk';
import { v4 as uuidv4 } from 'uuid';

interface BuildRetireTransactionDto {
  tonnes: number;
  reason: string;
  vintageYear: number;
  projectId: string;
  retirementAddress: string;
}

interface RetireTransactionQuote {
  xdr: string;
  nonce: string;
  fee: {
    baseFee: string;
    networkFee: string;
    totalFee: string;
    currency: string;
  };
  retirementId: string;
  validUntil: number;
}

@Injectable()
export class RetireTxService {
  constructor(
    private supabaseService: SupabaseService,
    private stellarService: StellarService,
  ) {}

  async buildRetireTransaction(
    dto: BuildRetireTransactionDto,
  ): Promise<RetireTransactionQuote> {
    // 1. Validate input
    this.validateRetireInput(dto);

    // 2. Load contract details
    const contract = await this.loadRetireContract();

    // 3. Create retirement record (pending signature)
    const retirementId = uuidv4();
    const nonce = this.generateNonce();

    await this.supabaseService
      .from('retirements')
      .insert({
        id: retirementId,
        tonnes: dto.tonnes,
        reason: dto.reason,
        vintage_year: dto.vintageYear,
        project_id: dto.projectId,
        retirement_address: dto.retirementAddress,
        nonce: nonce,
        status: 'pending_signature',
        created_at: new Date().toISOString(),
      });

    // 4. Build XDR transaction
    const sourceAccount = await this.stellarService.getServerAccount(
      contract.deployerAddress,
    );

    const builder = new StellarSDK.TransactionBuilder(sourceAccount, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase: StellarSDK.Networks.TESTNET_NETWORK_PASSPHRASE,
    });

    // Add retire operation
    const retireOp = {
      type: 'invokeHostFunction',
      hostFunction: StellarSDK.xdr.HostFunction.hostFunctionTypeInvokeContract([
        contract.address,
        'retire',
        [
          StellarSDK.nativeToScVal(dto.tonnes),
          StellarSDK.nativeToScVal(dto.reason),
          StellarSDK.nativeToScVal(nonce),
        ],
      ]),
    };

    const transaction = builder
      .addOperation(retireOp as any)
      .setNetworkPassphrase(StellarSDK.Networks.TESTNET_NETWORK_PASSPHRASE)
      .setTimeout(180)
      .build();

    const xdr = transaction.toEnvelope().toXDR('base64');

    // 5. Calculate fees
    const fee = await this.calculateRetireFee(dto.tonnes);

    // 6. Set expiry (5 minutes)
    const validUntil = Math.floor(Date.now() / 1000) + 300;

    return {
      xdr,
      nonce,
      fee,
      retirementId,
      validUntil,
    };
  }

  async submitRetireTransaction(
    dto: SubmitRetireTransactionDto,
  ): Promise<{ status: string; retirementId: string }> {
    const { xdr, signature, retirementId, nonce } = dto;

    // 1. Verify nonce hasn't been used
    const existing = await this.supabaseService
      .from('retirements')
      .select('*')
      .eq('id', retirementId)
      .eq('nonce', nonce)
      .single();

    if (!existing.data || existing.data.status !== 'pending_signature') {
      throw new Error('Invalid or expired retirement request');
    }

    // 2. Verify signature
    const isValidSignature = await this.verifyTransactionSignature(
      xdr,
      signature,
      existing.data.retirement_address,
    );

    if (!isValidSignature) {
      throw new Error('Invalid signature');
    }

    // 3. Submit to Stellar
    try {
      const response = await this.stellarService.submitTransaction(xdr);

      // 4. Update retirement status
      await this.supabaseService
        .from('retirements')
        .update({
          status: 'submitted',
          transaction_hash: response.hash,
          submitted_at: new Date().toISOString(),
        })
        .eq('id', retirementId);

      return {
        status: 'submitted',
        retirementId,
      };
    } catch (error) {
      throw new Error(`Failed to submit transaction: ${error.message}`);
    }
  }

  private validateRetireInput(dto: BuildRetireTransactionDto): void {
    if (dto.tonnes <= 0 || dto.tonnes > 1_000_000) {
      throw new Error('Tonnes must be between 0 and 1,000,000');
    }
    if (!dto.reason || dto.reason.length > 500) {
      throw new Error('Reason must be provided and less than 500 chars');
    }
    if (dto.vintageYear < 1990 || dto.vintageYear > new Date().getFullYear()) {
      throw new Error('Invalid vintage year');
    }
  }

  private async calculateRetireFee(tonnes: number): Promise<any> {
    // Base fee + volume-based adjustment
    const baseFee = '0.001'; // XLM
    const volumeFee = (tonnes * 0.00001).toString();
    const totalFee = (parseFloat(baseFee) + parseFloat(volumeFee)).toString();

    return {
      baseFee,
      networkFee: '0',
      totalFee,
      currency: 'XLM',
    };
  }

  private generateNonce(): string {
    return require('crypto').randomBytes(32).toString('hex');
  }

  private async verifyTransactionSignature(
    xdr: string,
    signature: string,
    signerAddress: string,
  ): Promise<boolean> {
    try {
      const transaction = StellarSDK.TransactionEnvelope.fromXDR(
        xdr,
        StellarSDK.Networks.TESTNET_NETWORK_PASSPHRASE,
      );

      const keypair = StellarSDK.Keypair.fromPublicKey(signerAddress);
      return keypair.verify(transaction.hash(), Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }

  private async loadRetireContract(): Promise<any> {
    return this.supabaseService
      .from('contracts')
      .select('*')
      .eq('name', 'retire')
      .eq('network', 'testnet')
      .single();
  }
}
```

#### 3. Frontend Retire Wizard Component

```typescript
// frontend/src/app/retire/retire-wizard.component.ts
import { Component, OnInit } from '@angular/core';
import { RetireService } from './retire.service';
import { WalletService } from '../wallet/wallet.service';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'app-retire-wizard',
  templateUrl: './retire-wizard.component.html',
  styleUrls: ['./retire-wizard.component.scss'],
})
export class RetireWizardComponent implements OnInit {
  step: 'input' | 'preview' | 'signing' | 'submitted' = 'input';

  // Form
  tonnes: number = 0;
  reason: string = '';
  vintageYear: number = new Date().getFullYear();
  projectId: string = '';

  // Quote
  quote: any = null;
  loading = false;
  error: string | null = null;

  // Transaction state
  signedXdr: string | null = null;
  submitting = false;
  retirementId: string | null = null;

  constructor(
    private retireService: RetireService,
    private walletService: WalletService,
    private toastr: ToastrService,
  ) {}

  ngOnInit(): void {
    this.walletService.ensureConnected();
  }

  async proceed(): Promise<void> {
    this.loading = true;
    this.error = null;

    try {
      // Step 1: Build transaction
      this.quote = await this.retireService.buildRetireTransaction({
        tonnes: this.tonnes,
        reason: this.reason,
        vintageYear: this.vintageYear,
        projectId: this.projectId,
        retirementAddress: this.walletService.currentAddress,
      });

      this.retirementId = this.quote.retirementId;
      this.step = 'preview';
    } catch (err) {
      this.error = this.mapError(err);
      this.toastr.error(this.error);
    } finally {
      this.loading = false;
    }
  }

  async sign(): Promise<void> {
    if (!this.quote) return;

    this.loading = true;
    this.error = null;

    try {
      // Step 2: Sign transaction
      const signResult = await this.walletService.signTransaction(
        this.quote.xdr,
        {
          networkPassphrase: 'Test SDF Network ; September 2015',
        },
      );

      this.signedXdr = signResult.signedEnvelope;
      this.step = 'signing';

      // Step 3: Submit transaction
      this.submitting = true;
      const result = await this.retireService.submitRetireTransaction({
        xdr: this.quote.xdr,
        signature: signResult.signature,
        retirementId: this.retirementId!,
        nonce: this.quote.nonce,
      });

      this.step = 'submitted';
      this.toastr.success(
        `Retirement submitted! Transaction: ${result.retirementId}`,
      );
    } catch (err) {
      const mappedError = this.mapError(err);
      this.error = mappedError;
      this.toastr.error(mappedError);

      if (this.shouldRetry(err)) {
        // Reset to allow retry
        this.step = 'preview';
      }
    } finally {
      this.loading = false;
      this.submitting = false;
    }
  }

  private mapError(error: any): string {
    if (error.message.includes('Rejected')) {
      return 'You rejected the transaction signature. Please try again.';
    }
    if (error.message.includes('insufficient funds')) {
      return 'Your wallet has insufficient funds for this retirement.';
    }
    if (error.message.includes('nonce race')) {
      return 'Another retirement was submitted. Please build a new transaction.';
    }
    if (error.message.includes('timeout')) {
      return 'Transaction timed out. Please try again.';
    }
    return error.message || 'An unexpected error occurred';
  }

  private shouldRetry(error: any): boolean {
    return (
      error.message.includes('timeout') ||
      error.message.includes('nonce race')
    );
  }
}
```

---

## Issue #949: Governance and Contract Auto-Upgrade Admin Wiring

### Governance Service Implementation

```typescript
// api/src/governance/governance.controller.ts
import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GovernanceService } from './governance.service';

@Controller('api/v1/governance')
export class GovernanceController {
  constructor(private governanceService: GovernanceService) {}

  @Post('proposals')
  @UseGuards(AuthGuard('jwt'))
  async createProposal(@Body() dto: CreateProposalDto) {
    return this.governanceService.createProposal(dto);
  }

  @Get('proposals/:id')
  async getProposal(@Param('id') id: string) {
    return this.governanceService.getProposal(id);
  }

  @Post('proposals/:id/sign')
  @UseGuards(AuthGuard('jwt'))
  async signProposal(
    @Param('id') id: string,
    @Body() dto: SignProposalDto,
  ) {
    return this.governanceService.signProposal(id, dto);
  }

  @Post('proposals/:id/execute')
  @UseGuards(AuthGuard('jwt'))
  async executeProposal(@Param('id') id: string) {
    return this.governanceService.executeProposal(id);
  }

  @Get('proposals')
  async listProposals(@Query() query: ListProposalsDto) {
    return this.governanceService.listProposals(query);
  }
}

// api/src/governance/governance.service.ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { StellarService } from '../stellar/stellar.service';
import { AuditService } from '../audit/audit.service';
import { v4 as uuidv4 } from 'uuid';

interface CreateProposalDto {
  type: 'upgrade' | 'admin_op' | 'parameter_change';
  contractId: string;
  action: string;
  description: string;
  parameters: Record<string, any>;
  lockDurationHours?: number;
  requiredSignatures?: number;
}

interface SignProposalDto {
  signature: string;
  signerAddress: string;
}

@Injectable()
export class GovernanceService {
  private readonly DEFAULT_LOCK_DURATION = 72; // 72 hours
  private readonly DEFAULT_REQUIRED_SIGS = 2; // Multi-sig requirement

  constructor(
    private supabaseService: SupabaseService,
    private stellarService: StellarService,
    private auditService: AuditService,
  ) {}

  async createProposal(dto: CreateProposalDto): Promise<any> {
    // 1. Validate proposal type
    if (!['upgrade', 'admin_op', 'parameter_change'].includes(dto.type)) {
      throw new Error('Invalid proposal type');
    }

    // 2. Check for duplicate active proposals
    const existing = await this.supabaseService
      .from('governance_proposals')
      .select('*')
      .eq('contract_id', dto.contractId)
      .eq('action', dto.action)
      .eq('status', 'staged')
      .limit(1);

    if (existing.data && existing.data.length > 0) {
      throw new Error('Duplicate proposal already staged for this action');
    }

    // 3. Calculate lock expiry
    const lockDuration = dto.lockDurationHours || this.DEFAULT_LOCK_DURATION;
    const lockExpiresAt = new Date(
      Date.now() + lockDuration * 60 * 60 * 1000,
    );

    const proposalId = uuidv4();

    // 4. Create proposal record
    const { data, error } = await this.supabaseService
      .from('governance_proposals')
      .insert({
        id: proposalId,
        type: dto.type,
        contract_id: dto.contractId,
        action: dto.action,
        description: dto.description,
        parameters: dto.parameters,
        lock_expires_at: lockExpiresAt.toISOString(),
        required_signatures: dto.requiredSignatures || this.DEFAULT_REQUIRED_SIGS,
        status: 'staged',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    // 5. Audit
    await this.auditService.log({
      action: 'governance_proposal_created',
      resourceId: proposalId,
      details: {
        type: dto.type,
        contractId: dto.contractId,
        lockExpiresAt: lockExpiresAt.toISOString(),
      },
    });

    return data;
  }

  async signProposal(
    proposalId: string,
    dto: SignProposalDto,
  ): Promise<any> {
    // 1. Load proposal
    const { data: proposal, error: pError } = await this.supabaseService
      .from('governance_proposals')
      .select('*')
      .eq('id', proposalId)
      .single();

    if (pError || !proposal) throw new Error('Proposal not found');

    // 2. Check status (must be staged)
    if (proposal.status !== 'staged') {
      throw new Error(`Cannot sign proposal in status: ${proposal.status}`);
    }

    // 3. Check lock expiry
    if (new Date(proposal.lock_expires_at) <= new Date()) {
      throw new Error('Proposal lock period has expired');
    }

    // 4. Verify signature
    const isValid = await this.verifySignature(
      proposalId,
      dto.signature,
      dto.signerAddress,
    );

    if (!isValid) {
      throw new Error('Invalid signature');
    }

    // 5. Record signature
    const { error: sError } = await this.supabaseService
      .from('governance_signatures')
      .insert({
        id: uuidv4(),
        proposal_id: proposalId,
        signer_address: dto.signerAddress,
        signature: dto.signature,
        signed_at: new Date().toISOString(),
      });

    if (sError) throw sError;

    // 6. Check if proposal can be executed
    const { data: signatures } = await this.supabaseService
      .from('governance_signatures')
      .select('*')
      .eq('proposal_id', proposalId);

    const signatureCount = signatures ? signatures.length : 0;
    const canExecute = signatureCount >= proposal.required_signatures;

    // 7. Update proposal status
    if (canExecute) {
      await this.supabaseService
        .from('governance_proposals')
        .update({ status: 'ready_to_execute' })
        .eq('id', proposalId);
    }

    // 8. Audit
    await this.auditService.log({
      action: 'governance_proposal_signed',
      resourceId: proposalId,
      details: {
        signer: dto.signerAddress,
        signatureCount,
        canExecute,
      },
    });

    return {
      proposalId,
      signed: true,
      signatureCount,
      canExecute,
    };
  }

  async executeProposal(proposalId: string): Promise<any> {
    // 1. Load proposal
    const { data: proposal } = await this.supabaseService
      .from('governance_proposals')
      .select('*')
      .eq('id', proposalId)
      .single();

    if (!proposal) throw new Error('Proposal not found');

    // 2. Check status (must be ready)
    if (proposal.status !== 'ready_to_execute') {
      throw new Error('Proposal is not ready for execution');
    }

    // 3. Check lock expiry
    if (new Date(proposal.lock_expires_at) > new Date()) {
      throw new Error('Lock period has not expired');
    }

    // 4. Get signatures
    const { data: signatures } = await this.supabaseService
      .from('governance_signatures')
      .select('*')
      .eq('proposal_id', proposalId);

    if (!signatures || signatures.length < proposal.required_signatures) {
      throw new Error('Insufficient signatures');
    }

    try {
      // 5. Execute on-chain
      const result = await this.executeOnChain(proposal, signatures);

      // 6. Update status
      await this.supabaseService
        .from('governance_proposals')
        .update({
          status: 'executed',
          executed_at: new Date().toISOString(),
          transaction_hash: result.hash,
        })
        .eq('id', proposalId);

      // 7. Audit
      await this.auditService.log({
        action: 'governance_proposal_executed',
        resourceId: proposalId,
        details: {
          transactionHash: result.hash,
          signerCount: signatures.length,
        },
      });

      return {
        proposalId,
        executed: true,
        transactionHash: result.hash,
      };
    } catch (error) {
      throw new Error(`Execution failed: ${error.message}`);
    }
  }

  private async executeOnChain(
    proposal: any,
    signatures: any[],
  ): Promise<any> {
    // Build and submit transaction based on proposal type
    // This is pseudo-code; actual implementation depends on contract specifics
    const transaction = this.buildGovernanceTransaction(proposal, signatures);
    return this.stellarService.submitTransaction(transaction);
  }

  private buildGovernanceTransaction(proposal: any, signatures: any[]): string {
    // Build XDR based on proposal type and parameters
    // Implementation depends on specific contract interfaces
    throw new Error('Not implemented');
  }

  private async verifySignature(
    proposalId: string,
    signature: string,
    signerAddress: string,
  ): Promise<boolean> {
    // Verify that the signer signed the proposal hash
    try {
      const message = `governance:${proposalId}`;
      const keypair = require('stellar-sdk').Keypair.fromPublicKey(signerAddress);
      return keypair.verify(
        Buffer.from(message),
        Buffer.from(signature, 'base64'),
      );
    } catch {
      return false;
    }
  }

  async listProposals(query: ListProposalsDto): Promise<any[]> {
    let q = this.supabaseService
      .from('governance_proposals')
      .select('*');

    if (query.status) q = q.eq('status', query.status);
    if (query.type) q = q.eq('type', query.type);
    if (query.contractId) q = q.eq('contract_id', query.contractId);

    return (await q.order('created_at', { ascending: false })).data || [];
  }
}
```

---

## Issue #947: Read-Heavy Routes Share One Coarse Rate Limit

### Throttle Strategy Implementation

```typescript
// api/src/common/throttle.strategy.ts
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModuleOptions } from '@nestjs/throttler';

export enum RouteClass {
  AUTH = 'auth',
  READ = 'read',
  WRITE = 'write',
  ADMIN = 'admin',
}

@Injectable()
export class DynamicThrottlerGuard extends ThrottlerGuard {
  getRouteSpecificLimit(routeClass: RouteClass): [limit: number, ttl: number] {
    const limits: Record<RouteClass, [number, number]> = {
      [RouteClass.AUTH]: [100, 900], // 100 requests per 15 minutes
      [RouteClass.READ]: [1000, 300], // 1000 requests per 5 minutes
      [RouteClass.WRITE]: [50, 300], // 50 requests per 5 minutes
      [RouteClass.ADMIN]: [20, 300], // 20 requests per 5 minutes
    };

    return limits[routeClass];
  }
}

// api/src/common/route-class.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { RouteClass } from './throttle.strategy';

export const RouteClassDecorator = (routeClass: RouteClass) =>
  SetMetadata('routeClass', routeClass);

export const ReadRoute = () => RouteClassDecorator(RouteClass.READ);
export const WriteRoute = () => RouteClassDecorator(RouteClass.WRITE);
export const AuthRoute = () => RouteClassDecorator(RouteClass.AUTH);
export const AdminRoute = () => RouteClassDecorator(RouteClass.ADMIN);
```

### Usage in Controllers

```typescript
// api/src/marketplace/marketplace.controller.ts
import { Controller, Get, UseGuards, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ReadRoute } from '../common/route-class.decorator';

@Controller('api/v1/marketplace')
export class MarketplaceController {
  constructor(private marketplaceService: MarketplaceService) {}

  @Get('listings')
  @ReadRoute()
  @Throttle({ default: { limit: 1000, ttl: 300 } })
  async getListings(@Query() query: GetListingsDto) {
    return this.marketplaceService.getListings(query);
  }

  @Get('listings/:id')
  @ReadRoute()
  @Throttle({ default: { limit: 1000, ttl: 300 } })
  async getListingDetail(@Param('id') id: string) {
    return this.marketplaceService.getListingDetail(id);
  }
}

// api/src/retirement/retirement.controller.ts
@Controller('api/v1/retirements')
export class RetirementController {
  @Post()
  @WriteRoute()
  @Throttle({ default: { limit: 50, ttl: 300 } })
  async createRetirement(@Body() dto: CreateRetirementDto) {
    return this.retirementService.create(dto);
  }

  @Patch(':id')
  @WriteRoute()
  @Throttle({ default: { limit: 50, ttl: 300 } })
  async updateRetirement(@Param('id') id: string, @Body() dto: UpdateRetirementDto) {
    return this.retirementService.update(id, dto);
  }
}
```

---

## Issue #948: Compliance Export Endpoints

### Compliance Report Service

```typescript
// api/src/compliance/compliance-report.service.ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import * as ExcelJS from 'exceljs';
import * as PDFDocument from 'pdfkit';

interface ComplianceReportParams {
  from: Date;
  to: Date;
  buyerId?: string;
  scope: '1' | '2' | '3'; // Scope 1, 2, or 3
}

@Injectable()
export class ComplianceReportService {
  constructor(private supabaseService: SupabaseService) {}

  async generateReport(
    params: ComplianceReportParams,
  ): Promise<{
    totals: ComplianceReportTotals;
    details: ComplianceReportDetail[];
  }> {
    // 1. Query aggregated data
    const query = this.supabaseService
      .from('retirements')
      .select(`
        id,
        tonnes,
        vintage_year,
        methodology,
        project:projects(
          id,
          name,
          methodology,
          verification_body
        ),
        created_at
      `)
      .gte('created_at', params.from.toISOString())
      .lte('created_at', params.to.toISOString())
      .eq('scope', params.scope);

    if (params.buyerId) {
      query.eq('buyer_id', params.buyerId);
    }

    const { data: retirements, error } = await query;
    if (error) throw error;

    // 2. Aggregate by vintage and methodology
    const aggregated = this.aggregateRetirements(retirements);

    // 3. Build report
    return {
      totals: this.calculateTotals(aggregated),
      details: aggregated,
    };
  }

  async exportCSV(
    params: ComplianceReportParams,
  ): Promise<Buffer> {
    const { totals, details } = await this.generateReport(params);

    let csv = 'Compliance Report - Scope ' + params.scope + '\n';
    csv += `Period: ${params.from.toISOString()} to ${params.to.toISOString()}\n`;
    csv += `Generated: ${new Date().toISOString()}\n\n`;

    // Totals section
    csv += 'SUMMARY\n';
    csv += `Total tCO2e Retired,${totals.totalTonnes}\n`;
    csv += `Total Projects,${totals.projectCount}\n`;
    csv += `Total Retirements,${totals.retirementCount}\n\n`;

    // Details section
    csv += 'Vintage,Methodology,Tonnes,Project Count\n';
    details.forEach((detail) => {
      csv += `${detail.vintage},${detail.methodology},${detail.tonnes},${detail.projectCount}\n`;
    });

    return Buffer.from(csv, 'utf-8');
  }

  async exportExcel(
    params: ComplianceReportParams,
  ): Promise<Buffer> {
    const { totals, details } = await this.generateReport(params);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Compliance Report');

    // Headers
    worksheet.columns = [
      { header: 'Vintage Year', key: 'vintage', width: 15 },
      { header: 'Methodology', key: 'methodology', width: 20 },
      { header: 'Tonnes (tCO2e)', key: 'tonnes', width: 15 },
      { header: 'Project Count', key: 'projectCount', width: 15 },
    ];

    // Add totals row
    const totalRow = worksheet.addRow({
      vintage: 'TOTAL',
      tonnes: totals.totalTonnes,
    });
    totalRow.font = { bold: true };

    // Add detail rows
    details.forEach((detail) => {
      worksheet.addRow(detail);
    });

    // Format
    worksheet.columns.forEach((column) => {
      column.alignment = { horizontal: 'center' };
    });

    return (await workbook.xlsx.writeBuffer()) as Buffer;
  }

  async exportPDF(
    params: ComplianceReportParams,
  ): Promise<Buffer> {
    const { totals, details } = await this.generateReport(params);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument();
      const chunks: Buffer[] = [];

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Title
      doc.fontSize(16).font('Helvetica-Bold').text('Compliance Report');
      doc.fontSize(10)
        .font('Helvetica')
        .text(`Scope ${params.scope} | Period: ${params.from.toLocaleDateString()} to ${params.to.toLocaleDateString()}`);

      // Summary
      doc.moveDown();
      doc.fontSize(12).font('Helvetica-Bold').text('Summary');
      doc.fontSize(10)
        .text(`Total tCO2e Retired: ${totals.totalTonnes}`)
        .text(`Total Projects: ${totals.projectCount}`)
        .text(`Total Retirements: ${totals.retirementCount}`);

      // Details table
      doc.moveDown();
      doc.fontSize(12).font('Helvetica-Bold').text('Breakdown by Vintage & Methodology');
      
      const tableTop = doc.y + 20;
      const col1X = 50;
      const col2X = 150;
      const col3X = 300;
      const col4X = 400;

      // Headers
      doc.fontSize(10)
        .font('Helvetica-Bold')
        .text('Vintage', col1X, tableTop)
        .text('Methodology', col2X, tableTop)
        .text('Tonnes', col3X, tableTop)
        .text('Projects', col4X, tableTop);

      // Rows
      let y = tableTop + 20;
      details.forEach((detail) => {
        doc.fontSize(9)
          .font('Helvetica')
          .text(String(detail.vintage), col1X, y)
          .text(detail.methodology, col2X, y)
          .text(String(detail.tonnes), col3X, y)
          .text(String(detail.projectCount), col4X, y);
        y += 20;
      });

      doc.end();
    });
  }

  private aggregateRetirements(retirements: any[]): ComplianceReportDetail[] {
    const aggregated = new Map<string, ComplianceReportDetail>();

    retirements.forEach((retirement) => {
      const key = `${retirement.vintage_year}:${retirement.project.methodology}`;
      
      if (!aggregated.has(key)) {
        aggregated.set(key, {
          vintage: retirement.vintage_year,
          methodology: retirement.project.methodology,
          tonnes: 0,
          projectCount: new Set<string>(),
        });
      }

      const entry = aggregated.get(key)!;
      entry.tonnes += retirement.tonnes;
      (entry.projectCount as any).add(retirement.project.id);
    });

    // Convert to array and finalize project count
    return Array.from(aggregated.values())
      .map((entry) => ({
        ...entry,
        projectCount: (entry.projectCount as any).size,
      }))
      .sort((a, b) => b.vintage - a.vintage);
  }

  private calculateTotals(
    details: ComplianceReportDetail[],
  ): ComplianceReportTotals {
    return {
      totalTonnes: details.reduce((sum, d) => sum + d.tonnes, 0),
      projectCount: details.reduce((sum, d) => sum + d.projectCount, 0),
      retirementCount: details.reduce((sum, d) => sum + 1, 0),
    };
  }
}

interface ComplianceReportDetail {
  vintage: number;
  methodology: string;
  tonnes: number;
  projectCount: number;
}

interface ComplianceReportTotals {
  totalTonnes: number;
  projectCount: number;
  retirementCount: number;
}
```

### Compliance Report Controller

```typescript
// api/src/compliance/compliance-report.controller.ts
import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { ComplianceReportService } from './compliance-report.service';
import { ReadRoute } from '../common/route-class.decorator';

@Controller('api/v1/compliance')
export class ComplianceReportController {
  constructor(private complianceService: ComplianceReportService) {}

  @Get('report')
  @ReadRoute()
  @UseGuards(AuthGuard('jwt'))
  async getReport(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('buyerId') buyerId?: string,
    @Query('scope') scope: '1' | '2' | '3' = '1',
  ) {
    return this.complianceService.generateReport({
      from: new Date(from),
      to: new Date(to),
      buyerId,
      scope,
    });
  }

  @Get('report/csv')
  @ReadRoute()
  @UseGuards(AuthGuard('jwt'))
  async getReportCSV(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('buyerId') buyerId?: string,
    @Query('scope') scope: '1' | '2' | '3' = '1',
    @Res() res: Response,
  ) {
    const buffer = await this.complianceService.exportCSV({
      from: new Date(from),
      to: new Date(to),
      buyerId,
      scope,
    });

    res.set('Content-Type', 'text/csv');
    res.set(
      'Content-Disposition',
      `attachment; filename="compliance-report-${Date.now()}.csv"`,
    );
    res.send(buffer);
  }

  @Get('report/excel')
  @ReadRoute()
  @UseGuards(AuthGuard('jwt'))
  async getReportExcel(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('buyerId') buyerId?: string,
    @Query('scope') scope: '1' | '2' | '3' = '1',
    @Res() res: Response,
  ) {
    const buffer = await this.complianceService.exportExcel({
      from: new Date(from),
      to: new Date(to),
      buyerId,
      scope,
    });

    res.set(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.set(
      'Content-Disposition',
      `attachment; filename="compliance-report-${Date.now()}.xlsx"`,
    );
    res.send(buffer);
  }

  @Get('report/pdf')
  @ReadRoute()
  @UseGuards(AuthGuard('jwt'))
  async getReportPDF(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('buyerId') buyerId?: string,
    @Query('scope') scope: '1' | '2' | '3' = '1',
    @Res() res: Response,
  ) {
    const buffer = await this.complianceService.exportPDF({
      from: new Date(from),
      to: new Date(to),
      buyerId,
      scope,
    });

    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      `attachment; filename="compliance-report-${Date.now()}.pdf"`,
    );
    res.send(buffer);
  }
}
```

---

## Testing & Deployment

### Test Coverage
- [ ] Retire flow: build XDR → sign → submit
- [ ] Cost calculation and fee display
- [ ] Error mapping (reject, insufficient funds, nonce race)
- [ ] Retry behavior after failure
- [ ] Governance proposal creation and lifecycle
- [ ] Multi-sig requirement enforcement
- [ ] Time-lock expiry validation
- [ ] Duplicate proposal prevention
- [ ] Rate limiting per route class
- [ ] Compliance report generation and export
- [ ] Report data accuracy with fixtures

### Deployment
- [ ] Add database tables for governance proposals/signatures
- [ ] Deploy retire transaction endpoints
- [ ] Deploy governance endpoints
- [ ] Update throttler configuration per route
- [ ] Deploy compliance export endpoints
- [ ] Test full flows on testnet
- [ ] Document all new endpoints
