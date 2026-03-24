/**
 * ERC-8183 Agentic Commerce Protocol — Barrel Export
 */
export { getACPClient } from './acp-client.js';
export { createArenaJob, submitArenaRound, settleArenaJob } from './hooks/arena-hook.js';
export { createPredictionJob, settlePredictionJob } from './hooks/prediction-hook.js';
export { createCommonsJob, settleCommonsJob } from './hooks/commons-hook.js';
export { createSpyJob, createIntelPurchaseJob, completeIntelPurchase, verifyIntelOnChain } from './hooks/intel-hook.js';
export { createPaywallJob, createTipJob, createDeathDistributionJob } from './hooks/split-payment-hook.js';
export * from './acp-types.js';
