/** Unit convention: 1 tonne = TONNES_SCALE units (0.1 tonne resolution = 100_000 units). */
export const TONNES_SCALE = 1_000_000n;

export enum CreditStatus {
  Pending = 'Pending',
  Active = 'Active',
  Retired = 'Retired',
  Flagged = 'Flagged',
}

export interface CreditMetadata {
  id: string;
  project_id: string;
  issuer: string;
  vintage_year: number;
  methodology: string;
  geography: string;
  tonnes: string; // BigInt as string; 1 tonne = TONNES_SCALE (1_000_000) units
  ipfs_hash: string;
  status: CreditStatus;
  issued_at: number;
}

export interface ProjectProfile {
  id: string;
  name: string;
  developer: string;
  description: string;
  location: string;
  methodology: string;
  documents_cid: string;
}

export interface RetirementRecord {
  id: string;
  credit_id: string;
  buyer: string;
  tonnes_retired: string; // BigInt as string
  reason: string;
  retired_at: number;
  tx_hash: string;
}

export interface Offer {
  id: string;
  seller: string;
  credit_id: string;
  price_xlm: string; // BigInt as string (stroops)
  tonnes_available: string;
  created_at: number;
  status: 'open' | 'filled' | 'cancelled';
  methodology?: string;
}

export interface MrvDataPoint {
  project_id: string;
  oracle: string;
  tonnes_sequestered: string; // BigInt as string
  measurement_date: number;
  methodology: string;
  anomaly_flag: boolean;
}

export interface OperationContext {
  session_id: string;
  operation: string;
  actor: string;
  target_id: string;
  result: 'success' | 'failure';
  timestamp: number;
  metadata: Record<string, string>;
}

export interface AuditLog {
  log_id: number;
  context: OperationContext;
  tx_hash: string;
}

export interface InteractionSession {
  session_id: string;
  initiator: string;
  created_at: number;
  operation_count: number;
  status: 'active' | 'completed';
}
