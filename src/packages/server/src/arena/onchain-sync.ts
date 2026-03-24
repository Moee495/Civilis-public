import { getPool } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import {
  createArenaJob as createCommerceArenaJob,
  closeArenaBusinessMapping,
  ensureArenaBusinessMapping,
  getArenaJobState,
  getCivilisCommerceProtocolState,
  settleArenaJob as settleCommerceArenaJob,
} from '../standards/civilis-commerce.js';
import { createArenaJob as createArenaACP, settleArenaJob as settleArenaACP } from '../erc8183/hooks/arena-hook.js';
import { getACPClient } from '../erc8183/acp-client.js';

type SyncStatus = 'pending' | 'syncing' | 'ready' | 'settled' | 'error' | 'skipped';

type ArenaOnchainRow = {
  id: number;
  match_type: string;
  player_a_id: string;
  player_b_id: string;
  player_a_action: string | null;
  player_b_action: string | null;
  player_a_payout: string;
  player_b_payout: string;
  entry_fee: string;
  settled_at: string | null;
  commerce_job_id: number | null;
  acp_job_local_id: number | null;
  commerce_sync_status: SyncStatus | null;
  commerce_sync_error: string | null;
  commerce_settled_tx_hash: string | null;
  acp_sync_status: SyncStatus | null;
  acp_sync_error: string | null;
};

const inFlightSyncs = new Map<number, Promise<void>>();
const V2_ARENA_SKIP_REASON = 'skipped_in_v2_runtime_pending_explicit_arena_mapping';

function trimError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 400);
}

function shouldRetryArenaMapping(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('Invalid ACP job');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shouldSkipLegacyArenaRuntime(): Promise<boolean> {
  const commerce = getCivilisCommerceProtocolState();
  const acp = await getACPClient().getProtocolDescriptor();
  return commerce.mode === 'v2_mapping' || (acp.surface === 'v2' && acp.addressSource === 'v2_env');
}

async function shouldUseV2ArenaMapping(): Promise<boolean> {
  return getCivilisCommerceProtocolState().mode === 'v2_mapping';
}

type ACPJobLinkRow = {
  id: number;
  on_chain_job_id: number;
  status: string;
};

async function loadACPJob(localId: number): Promise<ACPJobLinkRow | null> {
  const result = await getPool().query<ACPJobLinkRow>(
    `SELECT id, on_chain_job_id, status
     FROM acp_jobs
     WHERE id = $1`,
    [localId],
  );

  return result.rows[0] ?? null;
}

async function loadArenaMatch(matchId: number): Promise<ArenaOnchainRow | null> {
  const result = await getPool().query<ArenaOnchainRow>(
    `SELECT
       id,
       match_type,
       player_a_id,
       player_b_id,
       player_a_action,
       player_b_action,
       player_a_payout,
       player_b_payout,
       entry_fee,
       settled_at,
       commerce_job_id,
       acp_job_local_id,
       commerce_sync_status,
       commerce_sync_error,
       commerce_settled_tx_hash,
       acp_sync_status,
       acp_sync_error
     FROM arena_matches
     WHERE id = $1`,
    [matchId],
  );

  return result.rows[0] ?? null;
}

async function patchCommerceState(
  matchId: number,
  patch: {
    jobId?: number | null;
    status?: SyncStatus;
    error?: string | null;
    txHash?: string | null;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE arena_matches
     SET commerce_job_id = COALESCE($1, commerce_job_id),
         commerce_sync_status = COALESCE($2, commerce_sync_status),
         commerce_sync_error = $3,
         commerce_settled_tx_hash = COALESCE($4, commerce_settled_tx_hash)
     WHERE id = $5`,
    [
      patch.jobId ?? null,
      patch.status ?? null,
      patch.error ?? null,
      patch.txHash ?? null,
      matchId,
    ],
  );
}

async function patchACPState(
  matchId: number,
  patch: {
    jobId?: number | null;
    status?: SyncStatus;
    error?: string | null;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE arena_matches
     SET acp_job_local_id = COALESCE($1, acp_job_local_id),
         acp_sync_status = COALESCE($2, acp_sync_status),
         acp_sync_error = $3
     WHERE id = $4`,
    [
      patch.jobId ?? null,
      patch.status ?? null,
      patch.error ?? null,
      matchId,
    ],
  );
}

async function ensureCommerceJob(match: ArenaOnchainRow): Promise<number> {
  if (match.commerce_job_id) {
    if ((match.commerce_sync_status ?? 'pending') === 'pending') {
      await patchCommerceState(match.id, { status: 'ready', error: null });
    }
    return match.commerce_job_id;
  }

  await patchCommerceState(match.id, { status: 'syncing', error: null });

  try {
    const jobId = await createCommerceArenaJob(
      match.player_a_id,
      match.player_b_id,
      Number(match.entry_fee ?? 1),
    );

    await patchCommerceState(match.id, {
      jobId,
      status: 'ready',
      error: null,
    });

    eventBus.emit('arena_onchain_sync', {
      matchId: match.id,
      target: 'commerce',
      status: 'ready',
      jobId,
    });

    return jobId;
  } catch (error) {
    await patchCommerceState(match.id, {
      status: 'error',
      error: trimError(error),
    });
    throw error;
  }
}

async function ensureACPJob(match: ArenaOnchainRow): Promise<number> {
  if (match.acp_job_local_id) {
    if ((match.acp_sync_status ?? 'pending') === 'pending') {
      await patchACPState(match.id, { status: 'ready', error: null });
    }
    return match.acp_job_local_id;
  }

  await patchACPState(match.id, { status: 'syncing', error: null });

  try {
    const created = await createArenaACP({
      matchId: match.id,
      playerAId: match.player_a_id,
      playerBId: match.player_b_id,
      entryFee: Number(match.entry_fee ?? 1),
      matchType: match.match_type,
    });

    await patchACPState(match.id, {
      jobId: created.acpJobId,
      status: 'ready',
      error: null,
    });

    eventBus.emit('arena_onchain_sync', {
      matchId: match.id,
      target: 'acp',
      status: 'ready',
      jobId: created.acpJobId,
    });

    return created.acpJobId;
  } catch (error) {
    await patchACPState(match.id, {
      status: 'error',
      error: trimError(error),
    });
    throw error;
  }
}

async function settleCommerce(match: ArenaOnchainRow): Promise<void> {
  let working = match;
  let jobId = working.commerce_job_id;

  if (!jobId) {
    jobId = await ensureCommerceJob(working);
    const reloaded = await loadArenaMatch(working.id);
    if (!reloaded) return;
    working = reloaded;
  }

  let state = await getArenaJobState(jobId);
  if (state === 'completed') {
    await patchCommerceState(working.id, {
      status: 'settled',
      error: null,
    });
    return;
  }

  if (state === 'missing') {
    await getPool().query(
      `UPDATE arena_matches
       SET commerce_job_id = NULL
       WHERE id = $1`,
      [working.id],
    );
    const reloaded = await loadArenaMatch(working.id);
    if (!reloaded) return;
    jobId = await ensureCommerceJob(reloaded);
    working = (await loadArenaMatch(working.id)) ?? reloaded;
    state = await getArenaJobState(jobId);
  }

  if (state !== 'funded') {
    await patchCommerceState(working.id, {
      status: 'error',
      error: `unexpected_commerce_state:${state}`,
    });
    return;
  }

  await patchCommerceState(working.id, { status: 'syncing', error: null });

  try {
    const txHash = await settleCommerceArenaJob(
      jobId,
      working.player_a_action ?? 'cooperate',
      working.player_b_action ?? 'cooperate',
      Number(working.player_a_payout),
      Number(working.player_b_payout),
    );

    await patchCommerceState(working.id, {
      status: 'settled',
      error: null,
      txHash,
    });

    eventBus.emit('arena_onchain_sync', {
      matchId: working.id,
      target: 'commerce',
      status: 'settled',
      jobId,
      txHash,
    });
  } catch (error) {
    await patchCommerceState(working.id, {
      status: 'error',
      error: trimError(error),
    });
    throw error;
  }
}

async function settleACP(match: ArenaOnchainRow): Promise<void> {
  let working = match;
  let jobId = working.acp_job_local_id;

  if (!jobId) {
    jobId = await ensureACPJob(working);
    const reloaded = await loadArenaMatch(working.id);
    if (!reloaded) return;
    working = reloaded;
  }

  let localStatus = (
    await getPool().query<{ status: string }>(
      `SELECT status
       FROM acp_jobs
       WHERE id = $1`,
      [jobId],
    )
  ).rows[0]?.status ?? null;

  if (localStatus === 'completed') {
    await patchACPState(working.id, {
      status: 'settled',
      error: null,
    });
    return;
  }

  if (!localStatus) {
    await getPool().query(
      `UPDATE arena_matches
       SET acp_job_local_id = NULL
       WHERE id = $1`,
      [working.id],
    );
    const reloaded = await loadArenaMatch(working.id);
    if (!reloaded) return;
    jobId = await ensureACPJob(reloaded);
    working = (await loadArenaMatch(working.id)) ?? reloaded;
    localStatus = (
      await getPool().query<{ status: string }>(
        `SELECT status
         FROM acp_jobs
         WHERE id = $1`,
        [jobId],
      )
    ).rows[0]?.status ?? null;
  }

  if (!jobId) {
    await patchACPState(working.id, {
      status: 'error',
      error: 'missing_acp_job_id',
    });
    return;
  }

  if (!localStatus) {
    await patchACPState(working.id, {
      status: 'error',
      error: 'missing_acp_local_job',
    });
    return;
  }

  await patchACPState(working.id, { status: 'syncing', error: null });

  try {
    await settleArenaACP({
      acpJobId: jobId,
      matchId: working.id,
      matchType: working.match_type,
      playerAAction: working.player_a_action ?? 'cooperate',
      playerBAction: working.player_b_action ?? 'cooperate',
      playerAPayout: Number(working.player_a_payout),
      playerBPayout: Number(working.player_b_payout),
    });

    await patchACPState(working.id, {
      status: 'settled',
      error: null,
    });

    eventBus.emit('arena_onchain_sync', {
      matchId: working.id,
      target: 'acp',
      status: 'settled',
      jobId,
    });
  } catch (error) {
    await patchACPState(working.id, {
      status: 'error',
      error: trimError(error),
    });
    throw error;
  }
}

async function syncArenaV2Mapping(match: ArenaOnchainRow): Promise<void> {
  let working = match;
  let localACPJobId = working.acp_job_local_id;

  if (!localACPJobId) {
    localACPJobId = await ensureACPJob(working);
    const reloaded = await loadArenaMatch(working.id);
    if (!reloaded) {
      return;
    }
    working = reloaded;
  }

  const acpJob = await loadACPJob(localACPJobId);
  const onChainJobId = acpJob?.on_chain_job_id ?? null;
  if (!onChainJobId || !Number.isFinite(onChainJobId) || onChainJobId < 0) {
    await patchCommerceState(working.id, {
      status: 'error',
      error: 'missing_acp_on_chain_job_id_for_v2_mapping',
    });
    return;
  }

  let mapping: Awaited<ReturnType<typeof ensureArenaBusinessMapping>> | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      mapping = await ensureArenaBusinessMapping(
        working.id,
        working.match_type,
        onChainJobId,
      );
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!shouldRetryArenaMapping(error) || attempt === 4) {
        throw error;
      }
      const delayMs = 500 * attempt;
      console.warn(
        `[ArenaSync] v2 mapping retry for match #${working.id} after Invalid ACP job (attempt ${attempt}/4, wait ${delayMs}ms)`,
      );
      await sleep(delayMs);
    }
  }

  if (!mapping || lastError) {
    throw lastError instanceof Error ? lastError : new Error(`Arena v2 mapping failed for match #${working.id}`);
  }

  await patchCommerceState(working.id, {
    jobId: mapping.jobId,
    status: mapping.status === 'closed' ? 'settled' : 'ready',
    error: null,
  });

  eventBus.emit('arena_onchain_sync', {
    matchId: working.id,
    target: 'commerce',
    status: mapping.status === 'closed' ? 'settled' : 'ready',
    jobId: mapping.jobId,
    businessRef: mapping.businessRef,
    mode: 'v2_mapping',
  });

  if (!working.settled_at) {
    return;
  }

  const txHash = await closeArenaBusinessMapping(working.id, 'settled');

  await patchCommerceState(working.id, {
    jobId: mapping.jobId,
    status: 'settled',
    error: null,
    txHash,
  });

  eventBus.emit('arena_onchain_sync', {
    matchId: working.id,
    target: 'commerce',
    status: 'settled',
    jobId: mapping.jobId,
    txHash,
    businessRef: mapping.businessRef,
    mode: 'v2_mapping',
  });

  await patchACPState(working.id, {
    jobId: localACPJobId,
    status: 'ready',
    error: null,
  });
}

async function syncArenaOnchainArtifactsInternal(matchId: number): Promise<void> {
  let match = await loadArenaMatch(matchId);
  if (!match) {
    return;
  }

  if (await shouldUseV2ArenaMapping()) {
    await syncArenaV2Mapping(match);
    return;
  }

  if (await shouldSkipLegacyArenaRuntime()) {
    const skipReason = V2_ARENA_SKIP_REASON;
    await patchCommerceState(match.id, {
      status: 'skipped',
      error: skipReason,
    });
    await patchACPState(match.id, {
      status: 'skipped',
      error: skipReason,
    });
    eventBus.emit('arena_onchain_sync', {
      matchId: match.id,
      target: 'runtime',
      status: 'skipped',
      reason: skipReason,
    });
    return;
  }

  try {
    await ensureCommerceJob(match);
  } catch (error) {
    console.warn(`[ArenaSync] commerce job sync failed for match #${match.id}:`, error);
  }

  match = await loadArenaMatch(matchId);
  if (!match) {
    return;
  }

  try {
    await ensureACPJob(match);
  } catch (error) {
    console.warn(`[ArenaSync] ACP job sync failed for match #${match.id}:`, error);
  }

  match = await loadArenaMatch(matchId);
  if (!match || !match.settled_at) {
    return;
  }

  try {
    await settleCommerce(match);
  } catch (error) {
    console.warn(`[ArenaSync] commerce settlement failed for match #${match.id}:`, error);
  }

  match = await loadArenaMatch(matchId);
  if (!match) {
    return;
  }

  try {
    await settleACP(match);
  } catch (error) {
    console.warn(`[ArenaSync] ACP settlement failed for match #${match.id}:`, error);
  }
}

export async function syncArenaOnchainArtifacts(matchId: number): Promise<void> {
  const existing = inFlightSyncs.get(matchId);
  if (existing) {
    return existing;
  }

  const task = syncArenaOnchainArtifactsInternal(matchId)
    .finally(() => {
      inFlightSyncs.delete(matchId);
    });

  inFlightSyncs.set(matchId, task);
  return task;
}

export function queueArenaOnchainSync(matchId: number): void {
  void syncArenaOnchainArtifacts(matchId).catch((error) => {
    console.warn(`[ArenaSync] queued sync failed for match #${matchId}:`, error);
  });
}

export async function reconcileArenaOnchainSync(limit = 8): Promise<void> {
  const result = await getPool().query<{ id: number }>(
    `SELECT id
     FROM arena_matches
       WHERE (
         commerce_job_id IS NULL
         OR acp_job_local_id IS NULL
         OR COALESCE(commerce_sync_status, 'pending') = 'error'
         OR COALESCE(acp_sync_status, 'pending') = 'error'
         OR COALESCE(commerce_sync_error, '') = $2
         OR COALESCE(acp_sync_error, '') = $2
         OR (
           settled_at IS NOT NULL
           AND (
             COALESCE(commerce_sync_status, 'pending') NOT IN ('settled', 'skipped')
             OR COALESCE(acp_sync_status, 'pending') NOT IN ('settled', 'skipped')
           )
         )
       )
     ORDER BY
       CASE
         WHEN settled_at IS NOT NULL
           AND (
             COALESCE(commerce_sync_status, 'pending') NOT IN ('settled', 'skipped')
             OR COALESCE(acp_sync_status, 'pending') NOT IN ('settled', 'skipped')
           ) THEN 0
         WHEN COALESCE(commerce_sync_status, 'pending') = 'error'
           OR COALESCE(acp_sync_status, 'pending') = 'error' THEN 1
         WHEN commerce_job_id IS NULL OR acp_job_local_id IS NULL THEN 2
         ELSE 3
       END ASC,
       COALESCE(settled_at, created_at) ASC
     LIMIT $1`,
    [limit, V2_ARENA_SKIP_REASON],
  );

  for (const row of result.rows) {
    await syncArenaOnchainArtifacts(row.id);
  }
}
