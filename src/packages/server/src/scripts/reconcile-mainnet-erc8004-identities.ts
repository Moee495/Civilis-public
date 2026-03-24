import '../config/load-env.js';
import { ethers } from 'ethers';
import { getPool } from '../db/postgres.js';
import { initOkxTeeWallet } from '../onchainos/okx-tee-wallet.js';
import {
  executeRoleWrite,
  getSharedProvider,
  getSharedSignerAddress,
} from '../onchainos/shared-signers.js';
import { initERC8004, registerAgentOnERC8004 } from '../standards/erc8004.js';
import { generateAgentCard, toAgentCardUri } from '../standards/agent-card.js';
import type { FateCard } from '../fate/fate-card.js';

const IDENTITY_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getAgentWallet(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function transferFrom(address from, address to, uint256 tokenId)',
] as const;

const EXPECTED_SEQUENCE = [
  { agentId: 'chaos', tokenId: 1 },
  { agentId: 'echo', tokenId: 2 },
  { agentId: 'fox', tokenId: 3 },
  { agentId: 'hawk', tokenId: 4 },
  { agentId: 'monk', tokenId: 5 },
  { agentId: 'oracle', tokenId: 6 },
  { agentId: 'sage', tokenId: 7 },
  { agentId: 'whale', tokenId: 8 },
] as const;

type AgentRow = {
  agent_id: string;
  name: string;
  archetype: string;
  wallet_address: string;
  erc8004_token_id: number | null;
  erc8004_registration_mode: string | null;
  block_hash: string;
  block_number: number;
  mbti: string;
  wuxing: FateCard['wuxing'];
  zodiac: string;
  tarot_major: number;
  tarot_name: string;
  civilization: string;
  element_detail: FateCard['elementDetail'];
  raw_seed: string;
  is_revealed: boolean;
  revealed_dimensions: string[];
};

type TokenState = {
  tokenId: number;
  owner: string | null;
  agentWallet: string | null;
  tokenURI: string | null;
};

function getIdentityAddress(): string {
  const address = process.env.ERC8004_IDENTITY_V2_ADDRESS || process.env.ERC8004_IDENTITY_ADDRESS;
  if (!address) {
    throw new Error('Missing ERC8004 identity registry address');
  }
  return address;
}

async function readTokenState(
  contract: ethers.Contract,
  tokenId: number,
): Promise<TokenState> {
  let owner: string | null = null;
  let agentWallet: string | null = null;
  let tokenURI: string | null = null;

  try {
    owner = String(await contract.ownerOf(tokenId));
  } catch {
    owner = null;
  }

  try {
    agentWallet = String(await contract.getAgentWallet(tokenId));
  } catch {
    agentWallet = null;
  }

  try {
    tokenURI = String(await contract.tokenURI(tokenId));
  } catch {
    tokenURI = null;
  }

  return { tokenId, owner, agentWallet, tokenURI };
}

function buildFateCard(row: AgentRow): FateCard {
  return {
    agentId: row.agent_id,
    blockHash: row.block_hash,
    blockNumber: Number(row.block_number),
    mbti: row.mbti,
    wuxing: row.wuxing,
    zodiac: row.zodiac,
    tarotMajor: Number(row.tarot_major),
    tarotName: row.tarot_name,
    civilization: row.civilization,
    elementDetail: row.element_detail,
    rawSeed: row.raw_seed,
    isRevealed: row.is_revealed,
    revealedDimensions: Array.isArray(row.revealed_dimensions) ? row.revealed_dimensions : [],
  };
}

async function main(): Promise<void> {
  initOkxTeeWallet();
  initERC8004();

  const pool = getPool();
  const provider = getSharedProvider();
  const identityAddress = getIdentityAddress();
  const sharedIdentitySigner = getSharedSignerAddress('erc8004_identity');
  if (!sharedIdentitySigner) {
    throw new Error('Missing shared erc8004_identity signer address');
  }

  const contract = new ethers.Contract(identityAddress, IDENTITY_ABI, provider);
  const agentResult = await pool.query<AgentRow>(
    `SELECT
       a.agent_id,
       a.name,
       a.archetype,
       a.wallet_address,
       a.erc8004_token_id,
       a.erc8004_registration_mode,
       f.block_hash,
       f.block_number,
       f.mbti,
       f.wuxing,
       f.zodiac,
       f.tarot_major,
       f.tarot_name,
       f.civilization,
       f.element_detail,
       f.raw_seed,
       f.is_revealed,
       f.revealed_dimensions
     FROM agents a
     JOIN fate_cards f ON f.agent_id = a.agent_id
     WHERE a.agent_id = ANY($1::text[])
     ORDER BY a.agent_id`,
    [EXPECTED_SEQUENCE.map((entry) => entry.agentId)],
  );

  const agents = new Map(agentResult.rows.map((row) => [row.agent_id, row]));
  if (agents.size !== EXPECTED_SEQUENCE.length) {
    throw new Error(`Expected ${EXPECTED_SEQUENCE.length} agents, found ${agents.size}`);
  }

  for (const expected of EXPECTED_SEQUENCE) {
    const row = agents.get(expected.agentId);
    if (!row) {
      throw new Error(`Missing agent row for ${expected.agentId}`);
    }
    if (row.erc8004_token_id !== expected.tokenId) {
      throw new Error(
        `Local token mapping mismatch for ${expected.agentId}: expected ${expected.tokenId}, got ${row.erc8004_token_id}`,
      );
    }
  }

  const beforeStates = await Promise.all(
    EXPECTED_SEQUENCE.map(({ tokenId }) => readTokenState(contract, tokenId)),
  );
  console.log(
    JSON.stringify(
      {
        action: 'erc8004_identity_reconcile_precheck',
        identityRegistry: identityAddress,
        sharedIdentitySigner,
        tokens: beforeStates,
      },
      null,
      2,
    ),
  );

  const chaos = agents.get('chaos')!;
  const chaosState = beforeStates.find((state) => state.tokenId === 1)!;
  let chaosTransferTxHash: string | null = null;

  if (!chaosState.owner) {
    throw new Error('Token #1 is missing on-chain; cannot repair chaos ownership safely');
  }

  if (chaosState.owner.toLowerCase() === chaos.wallet_address.toLowerCase()) {
    console.log('[ERC8004-ID] chaos token already owned by chaos wallet');
  } else if (chaosState.owner.toLowerCase() === sharedIdentitySigner.toLowerCase()) {
    const receipt = await executeRoleWrite(
      'erc8004_identity',
      'erc8004.transferOwnership:1',
      async (signer) => {
        const writable = new ethers.Contract(identityAddress, IDENTITY_ABI, signer);
        const tx = await writable.transferFrom(sharedIdentitySigner, chaos.wallet_address, 1);
        return tx.wait();
      },
    );
    chaosTransferTxHash = receipt?.hash ?? null;
    await pool.query(
      `UPDATE agents
       SET erc8004_registration_mode = 'v2_owner_transfer'
       WHERE agent_id = 'chaos'`,
    );
  } else {
    throw new Error(
      `Token #1 is owned by unexpected address ${chaosState.owner}; refusing to mutate mainnet state`,
    );
  }

  const registrationResults: Array<Record<string, unknown>> = [];
  for (const { agentId, tokenId } of EXPECTED_SEQUENCE.slice(1)) {
    const row = agents.get(agentId)!;
    const tokenState = beforeStates.find((state) => state.tokenId === tokenId)!;

    if (tokenState.owner) {
      if (tokenState.owner.toLowerCase() !== row.wallet_address.toLowerCase()) {
        throw new Error(
          `Token #${tokenId} already exists on-chain but is owned by ${tokenState.owner}, not ${row.wallet_address}`,
        );
      }
      registrationResults.push({
        agentId,
        tokenId,
        mode: 'already_owned',
        owner: tokenState.owner,
        agentWallet: tokenState.agentWallet,
        txHash: null,
      });
      await pool.query(
        `UPDATE agents
         SET erc8004_registration_mode = 'v2'
         WHERE agent_id = $1`,
        [agentId],
      );
      continue;
    }

    const agentCardUri = toAgentCardUri(
      generateAgentCard(
        row.agent_id,
        row.name,
        row.archetype,
        row.wallet_address,
        buildFateCard(row),
      ),
    );
    const result = await registerAgentOnERC8004(row.agent_id, agentCardUri, row.wallet_address);
    if (!result || !result.onChainRegistered || !result.tokenId || !result.txHash) {
      throw new Error(`On-chain registration failed for ${agentId}`);
    }
    if (result.tokenId !== tokenId) {
      throw new Error(
        `Token sequence mismatch for ${agentId}: expected ${tokenId}, got ${result.tokenId}`,
      );
    }

    registrationResults.push({
      agentId,
      tokenId: result.tokenId,
      mode: result.mode,
      txHash: result.txHash,
    });
  }

  const afterStates = await Promise.all(
    EXPECTED_SEQUENCE.map(({ tokenId }) => readTokenState(contract, tokenId)),
  );
  console.log(
    JSON.stringify(
      {
        action: 'erc8004_identity_reconcile_postcheck',
        chaosTransferTxHash,
        registrations: registrationResults,
        tokens: afterStates,
      },
      null,
      2,
    ),
  );

  for (const { agentId, tokenId } of EXPECTED_SEQUENCE.slice(1)) {
    const row = agents.get(agentId)!;
    const tokenState = afterStates.find((state) => state.tokenId === tokenId)!;
    if (!tokenState.owner || tokenState.owner.toLowerCase() !== row.wallet_address.toLowerCase()) {
      throw new Error(`Owner verification failed for ${agentId} token #${tokenId}`);
    }
    if (!tokenState.agentWallet || tokenState.agentWallet.toLowerCase() !== row.wallet_address.toLowerCase()) {
      throw new Error(`Agent wallet metadata verification failed for ${agentId} token #${tokenId}`);
    }
  }

  const chaosAfter = afterStates.find((state) => state.tokenId === 1)!;
  if (!chaosAfter.owner || chaosAfter.owner.toLowerCase() !== chaos.wallet_address.toLowerCase()) {
    throw new Error(`Chaos ownership verification failed after token #1 transfer`);
  }

  const unblockResult = await pool.query<{ id: number }>(
    `UPDATE erc8004_feedback
     SET sync_state = 'legacy'
     WHERE on_chain_tx_hash IS NULL
       AND sync_state = 'blocked_identity'
       AND agent_erc8004_id = ANY($1::int[])
     RETURNING id`,
    [EXPECTED_SEQUENCE.map((entry) => entry.tokenId)],
  );

  console.log(
    JSON.stringify(
      {
        action: 'erc8004_identity_reconcile_complete',
        reactivatedBlockedIdentityRows: unblockResult.rowCount,
      },
      null,
      2,
    ),
  );

  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[ERC8004-ID] reconcile mainnet identities failed:', error);
    process.exit(1);
  });
