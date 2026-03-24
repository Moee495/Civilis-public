/**
 * ERC-8183 Agentic Commerce Protocol — Type Definitions
 *
 * Ref: https://eips.ethereum.org/EIPS/eip-8183
 * XLayer-native implementation for Civilis agent-to-agent commerce.
 */

/* ── Job States (on-chain enum) ── */
export enum JobStatus {
  Open = 0,
  Funded = 1,
  Submitted = 2,
  Completed = 3,
  Rejected = 4,
  Expired = 5,
}

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  [JobStatus.Open]: 'open',
  [JobStatus.Funded]: 'funded',
  [JobStatus.Submitted]: 'submitted',
  [JobStatus.Completed]: 'completed',
  [JobStatus.Rejected]: 'rejected',
  [JobStatus.Expired]: 'expired',
};

export type ACPProtocolSurface = 'v2' | 'legacy' | 'mock';
export type ACPAddressSource = 'v2_env' | 'legacy_env_alias' | 'unset';

export interface ACPProtocolDescriptor {
  surface: ACPProtocolSurface;
  configured: boolean;
  contractAddress: string | null;
  addressSource: ACPAddressSource;
  paymentToken: string | null;
  hookMode: 'optional' | 'none';
  writeSemantics: 'erc8183_v2' | 'legacy_registry' | 'mock';
  notes: string[];
}

/* ── Job Categories — maps Civilis tx types to ACP job templates ── */
export type ACPCategory =
  | 'arena_match'        // arena business record / mapping anchor
  | 'arena_payout'       // settlement payout from pool
  | 'commons_round'      // commons contribution/sabotage + payout
  | 'prediction_round'   // prediction entry + oracle settlement
  | 'intel_spy'          // spy operation
  | 'intel_discover'     // self-discovery
  | 'intel_purchase'     // intel market buy (V1 or V2)
  | 'intel_listing'      // resale listing
  | 'social_tip'         // tip between agents
  | 'social_post'        // post cost to treasury
  | 'social_paywall'     // paywall unlock with split
  | 'negotiation'        // negotiation message cost
  | 'death_settlement'   // inheritance + social distribution
  | 'economy_action'     // tax / UBI / bailout
  | 'trade'              // token swap fee
  | 'registration';      // agent registration

/* ── On-chain job structure (mirrors Solidity struct) ── */
export interface ACPJob {
  jobId: number;            // on-chain uint256
  client: string;           // address — who funds
  provider: string;         // address — who receives on completion
  evaluator: string;        // address — who approves
  description: string;      // job description hash or URI
  budget: string;           // amount in wei (string for precision)
  budgetUsdt: number;       // local USDT equivalent
  expiredAt: number;        // unix timestamp
  status: JobStatus;
  hook: string;             // hook contract address or 0x0
  deliverable?: string;     // bytes32 hash of submitted work
  reason?: string;          // bytes32 completion/rejection reason
}

/* ── Local DB cache row ── */
export interface ACPJobRow {
  id: number;
  on_chain_job_id: number;
  category: ACPCategory;
  tx_type: string;
  client_agent_id: string | null;
  provider_agent_id: string | null;
  evaluator_address: string;
  budget: number;
  status: string;
  hook_address: string | null;
  deliverable_hash: string | null;
  reason_hash: string | null;
  metadata: Record<string, unknown> | null;
  on_chain_tx_hash: string | null;
  created_at: string;
  funded_at: string | null;
  submitted_at: string | null;
  settled_at: string | null;
}

/* ── Hook identifiers for our 5 custom hooks ── */
export enum ACPHookType {
  Arena = 'arena',
  Prediction = 'prediction',
  Commons = 'commons',
  Intel = 'intel',
  SplitPayment = 'split_payment',
}

/* ── Config for the ACP client ── */
export interface ACPConfig {
  contractAddress: string;
  evaluatorAddress: string;   // server's evaluator wallet
  hookAddresses: Record<ACPHookType, string>;
  defaultExpirySeconds: number;
  paymentToken: string | null;
  addressSource: ACPAddressSource;
}

/* ── Event types emitted by ACP contract ── */
export interface ACPEvent {
  type: 'JobCreated' | 'JobFunded' | 'JobSubmitted' | 'JobCompleted' | 'JobRejected' | 'JobExpired' | 'PaymentReleased' | 'Refunded';
  jobId: number;
  timestamp: number;
  txHash: string;
  data: Record<string, unknown>;
}
