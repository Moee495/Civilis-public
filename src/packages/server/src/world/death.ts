import { ethers } from 'ethers';
import { getPool, withTransaction } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { judgeSoul } from '../standards/erc8004.js';
import { processX402Payment } from '../x402/payment-processor.js';
import { createDeathDistributionJob } from '../erc8183/hooks/split-payment-hook.js';
import {
  executeRoleWrite,
  getSharedSigner,
} from '../onchainos/shared-signers.js';
import { getAgentWalletAddressStrict } from '../agents/wallet-sync.js';
import { gatherLifeData, type LifeData } from './farewell-generator.js';
import { generateFarewellContent } from './farewell-llm.js';

const BASE_DEATH_THRESHOLD = 0.5;
const HIGH_REP_DEATH_THRESHOLD = 0.2;
const HIGH_REP_CUTOFF = 600;
const BAILOUT_REP_CUTOFF = 500;
const BAILOUT_PROBABILITY = 0.40;
const BAILOUT_TREASURY_MIN = 20;
const BAILOUT_BALANCE_SET = 1.5;
const BAILOUT_REP_COST = 200;
const BAILOUT_COOLDOWN_TICKS = 100; // Cannot be bailed out again within 100 ticks
const TWILIGHT_TICKS = 10;
const twilightAgents = new Map<string, number>();
const bailoutCooldowns = new Map<string, number>(); // agentId → last bailout tick

export async function checkDeathConditions(currentTick: number): Promise<void> {
  const pool = getPool();

  // Query all alive agents below the maximum threshold (0.5) — we filter by effective threshold in code
  const lowBalance = await pool.query<{ agent_id: string; balance: string; reputation_score: number }>(
    'SELECT agent_id, balance, reputation_score FROM agents WHERE is_alive = true AND balance < $1',
    [BASE_DEATH_THRESHOLD.toFixed(6)],
  );

  for (const agent of lowBalance.rows) {
    const balance = Number(agent.balance);
    const effectiveThreshold = agent.reputation_score > HIGH_REP_CUTOFF
      ? HIGH_REP_DEATH_THRESHOLD
      : BASE_DEATH_THRESHOLD;

    // If balance is above effective threshold, this agent is safe
    if (balance >= effectiveThreshold) {
      // Remove from twilight if they were in it
      if (twilightAgents.has(agent.agent_id)) {
        twilightAgents.delete(agent.agent_id);
        eventBus.emit('twilight_escaped', { agentId: agent.agent_id });
      }
      continue;
    }

    // ── Community bailout check (with cooldown) ──
    const lastBailout = bailoutCooldowns.get(agent.agent_id) ?? 0;
    const bailoutReady = (currentTick - lastBailout) >= BAILOUT_COOLDOWN_TICKS;
    if (bailoutReady && agent.reputation_score > BAILOUT_REP_CUTOFF && Math.random() < BAILOUT_PROBABILITY) {
      // Check treasury health
      const treasuryResult = await pool.query<{ balance: string }>(
        `SELECT COALESCE(
           SUM(CASE WHEN to_agent_id IS NULL THEN amount ELSE 0 END) -
           SUM(CASE WHEN from_agent_id IS NULL THEN amount ELSE 0 END),
         0) AS balance FROM x402_transactions`,
      );
      const treasuryBalance = Number(treasuryResult.rows[0]?.balance ?? 0);

      if (treasuryBalance > BAILOUT_TREASURY_MIN) {
        // Bailout successful
        await pool.query(
          'UPDATE agents SET balance = $1 WHERE agent_id = $2',
          [BAILOUT_BALANCE_SET.toFixed(6), agent.agent_id],
        );
        // Record treasury outflow
        await pool.query(
          `INSERT INTO x402_transactions (tx_type, from_agent_id, to_agent_id, amount, metadata)
           VALUES ('economy_bailout', NULL, $1, $2, $3)`,
          [agent.agent_id, BAILOUT_BALANCE_SET.toFixed(6), JSON.stringify({ tick: currentTick, reason: 'community_bailout' })],
        );
        // Reputation cost
        await pool.query(
          'UPDATE agents SET reputation_score = GREATEST(0, reputation_score - $1) WHERE agent_id = $2',
          [BAILOUT_REP_COST, agent.agent_id],
        );

        // Remove from twilight + record cooldown
        twilightAgents.delete(agent.agent_id);
        bailoutCooldowns.set(agent.agent_id, currentTick);

        eventBus.emit('bailout', {
          agentId: agent.agent_id,
          reputation: agent.reputation_score,
          newBalance: BAILOUT_BALANCE_SET,
          repCost: BAILOUT_REP_COST,
        });
        console.log(`[Death] ${agent.agent_id} BAILED OUT by community (rep: ${agent.reputation_score})`);
        continue;
      }
    }

    // ── Twilight / Death logic (original) ──
    if (!twilightAgents.has(agent.agent_id)) {
      twilightAgents.set(agent.agent_id, currentTick);
      eventBus.emit('twilight', {
        agentId: agent.agent_id,
        balance,
        ticksRemaining: TWILIGHT_TICKS,
      });
      continue;
    }

    const enteredTick = twilightAgents.get(agent.agent_id);
    if (enteredTick !== undefined && currentTick - enteredTick >= TWILIGHT_TICKS) {
      await executeAgentDeath(agent.agent_id, currentTick);
      twilightAgents.delete(agent.agent_id);
    }
  }

  // Recovery check for twilight agents who recovered above threshold
  for (const [agentId] of twilightAgents) {
    const recovered = await pool.query<{ balance: string; reputation_score: number }>(
      'SELECT balance, reputation_score FROM agents WHERE agent_id = $1 AND is_alive = true',
      [agentId],
    );
    if (recovered.rows[0]) {
      const effectiveThreshold = recovered.rows[0].reputation_score > HIGH_REP_CUTOFF
        ? HIGH_REP_DEATH_THRESHOLD
        : BASE_DEATH_THRESHOLD;
      if (Number(recovered.rows[0].balance) >= effectiveThreshold) {
        twilightAgents.delete(agentId);
        eventBus.emit('twilight_escaped', { agentId });
      }
    }
  }
}

async function executeAgentDeath(agentId: string, currentTick: number): Promise<void> {
  const pool = getPool();
  const agent = await pool.query<{
    name: string;
    archetype: string;
    balance: string;
    initial_balance: string;
    reputation_score: number;
  }>('SELECT * FROM agents WHERE agent_id = $1', [agentId]);

  if (!agent.rows[0]) {
    return;
  }

  const fateCard = await pool.query('SELECT * FROM fate_cards WHERE agent_id = $1', [agentId]);
  const memories = await pool.query<{ content: string }>(
    `SELECT content
     FROM agent_memories
     WHERE agent_id = $1
     ORDER BY importance DESC, created_at DESC
     LIMIT 10`,
    [agentId],
  );

  const remainingBalance = Number(agent.rows[0].balance);

  // Generate personalized farewell speech: LLM → Template → Fallback
  let farewellContent: string;
  let lifeData: LifeData | null = null;
  try {
    lifeData = await gatherLifeData(agentId, currentTick);
  } catch (err) {
    console.warn(`[Death] gatherLifeData failed for ${agentId}:`, err);
  }

  if (lifeData) {
    const farewell = await generateFarewellContent(lifeData, remainingBalance);
    farewellContent = farewell.content;
  } else {
    farewellContent = `My journey ends here. Final balance: ${remainingBalance.toFixed(4)} USDT. May those who follow go farther.`;
  }

  await pool.query(
    `INSERT INTO posts (author_agent_id, content, post_type)
     VALUES ($1, $2, 'farewell')`,
    [agentId, farewellContent],
  );

  // ── Death Inheritance: 35% Treasury (incl 5% estate tax), 35% Heir, 30% Social ──
  // Inheritance limited to 2 per recipient to prevent dynasty accumulation
  if (remainingBalance > 0) {
    const ESTATE_TAX_RATE = 0.05; // 5% estate tax
    const estateTax = remainingBalance * ESTATE_TAX_RATE;
    const afterTax = remainingBalance - estateTax;
    const treasuryShare = afterTax * 0.30 + estateTax; // 30% of post-tax + 5% estate tax ≈ 33.5%
    const inheritanceShare = afterTax * 0.40; // 40% of post-tax ≈ 38%
    const socialShare = afterTax * 0.30; // 30% of post-tax ≈ 28.5%

    await withTransaction(async (client) => {
      // Lock the dead agent's row
      await client.query('SELECT balance FROM agents WHERE agent_id = $1 FOR UPDATE', [agentId]);

      // 30% → Treasury (deduct from agent, record tx)
      await client.query(
        'UPDATE agents SET balance = GREATEST(0, balance - $1) WHERE agent_id = $2',
        [treasuryShare.toFixed(6), agentId],
      );
      await client.query(
        `INSERT INTO x402_transactions (tx_type, from_agent_id, to_agent_id, amount, metadata)
         VALUES ('death_treasury', $1, NULL, $2, $3)`,
        [agentId, treasuryShare.toFixed(6), JSON.stringify({ reason: 'agent_death_treasury_share', tick: currentTick })],
      );

      // 40% → Heir (highest trusted alive agent)
      const heir = await client.query<{ to_agent_id: string }>(
        `SELECT to_agent_id FROM trust_relations
         WHERE from_agent_id = $1
           AND to_agent_id IN (SELECT agent_id FROM agents WHERE is_alive = true)
         ORDER BY trust_score DESC LIMIT 1`,
        [agentId],
      );

      if (heir.rows.length > 0) {
        const heirId = heir.rows[0].to_agent_id;

        // Check inheritance limit: max 2 inheritances per recipient
        const inheritCount = await client.query<{ cnt: string }>(
          `SELECT COUNT(*) as cnt FROM x402_transactions WHERE tx_type = 'death_inheritance' AND to_agent_id = $1`,
          [heirId],
        );
        const canInherit = Number(inheritCount.rows[0]?.cnt ?? 0) < 2;

        if (canInherit) {
        await client.query(
          'UPDATE agents SET balance = GREATEST(0, balance - $1) WHERE agent_id = $2',
          [inheritanceShare.toFixed(6), agentId],
        );
        await client.query(
          'UPDATE agents SET balance = balance + $1 WHERE agent_id = $2',
          [inheritanceShare.toFixed(6), heirId],
        );
        await client.query(
          `INSERT INTO x402_transactions (tx_type, from_agent_id, to_agent_id, amount, metadata)
           VALUES ('death_inheritance', $1, $2, $3, $4)`,
          [agentId, heirId, inheritanceShare.toFixed(6), JSON.stringify({ reason: 'inheritance', tick: currentTick })],
        );
        console.log(`[Death] ${agent.rows[0].name}'s inheritance (${inheritanceShare.toFixed(4)}) → ${heirId}`);
        } else {
          // Heir at inheritance limit → treasury gets this share too
          await client.query(
            'UPDATE agents SET balance = GREATEST(0, balance - $1) WHERE agent_id = $2',
            [inheritanceShare.toFixed(6), agentId],
          );
          await client.query(
            `INSERT INTO x402_transactions (tx_type, from_agent_id, to_agent_id, amount, metadata)
             VALUES ('death_treasury', $1, NULL, $2, $3)`,
            [agentId, inheritanceShare.toFixed(6), JSON.stringify({ reason: 'heir_limit_exceeded', tick: currentTick })],
          );
          console.log(`[Death] ${agent.rows[0].name}'s heir at limit, inheritance → treasury`);
        }
      } else {
        // No heir → treasury gets it too
        await client.query(
          'UPDATE agents SET balance = GREATEST(0, balance - $1) WHERE agent_id = $2',
          [inheritanceShare.toFixed(6), agentId],
        );
        await client.query(
          `INSERT INTO x402_transactions (tx_type, from_agent_id, to_agent_id, amount, metadata)
           VALUES ('death_treasury', $1, NULL, $2, $3)`,
          [agentId, inheritanceShare.toFixed(6), JSON.stringify({ reason: 'agent_death_no_heir', tick: currentTick })],
        );
      }

      // 30% → Social (split among all alive agents)
      const aliveAgents = await client.query<{ agent_id: string }>(
        'SELECT agent_id FROM agents WHERE is_alive = true AND agent_id != $1',
        [agentId],
      );
      if (aliveAgents.rows.length > 0) {
        const perAgent = socialShare / aliveAgents.rows.length;
        if (perAgent > 0.0001) {
          await client.query(
            'UPDATE agents SET balance = GREATEST(0, balance - $1) WHERE agent_id = $2',
            [socialShare.toFixed(6), agentId],
          );
          const agentIds = aliveAgents.rows.map(a => a.agent_id);
          await client.query(
            'UPDATE agents SET balance = balance + $1 WHERE agent_id = ANY($2)',
            [perAgent.toFixed(6), agentIds],
          );
          await client.query(
            `INSERT INTO x402_transactions (tx_type, from_agent_id, to_agent_id, amount, metadata)
             VALUES ('death_social', $1, NULL, $2, $3)`,
            [agentId, socialShare.toFixed(6), JSON.stringify({
              reason: 'social_distribution', tick: currentTick,
              recipientCount: agentIds.length, perAgent: Number(perAgent.toFixed(6)),
            })],
          );
        }
      }
    });
  }

  const soul = await judgeSoul(agentId);
  const soulMetadata = {
    agentId,
    name: agent.rows[0].name,
    archetype: agent.rows[0].archetype,
    fateCard: fateCard.rows[0] ?? null,
    finalBalance: remainingBalance,
    initialBalance: Number(agent.rows[0].initial_balance),
    reputation: agent.rows[0].reputation_score,
    memories: memories.rows.map((memory) => memory.content),
    deathTick: currentTick,
    soulGrade: soul.grade,
  };
  // Mint an on-chain soul archive entry when configured; otherwise keep a deterministic archive hash.
  let soulHash: string;
  try {
    const soulData = JSON.stringify(soulMetadata);
    soulHash = ethers.keccak256(ethers.toUtf8Bytes(soulData));

    // Attempt on-chain soul archive mint when the optional contract is configured.
    const soulContract = process.env.SOUL_NFT_ADDRESS;

    if (getSharedSigner('soul') && soulContract) {
      const signer = getSharedSigner('soul')!;
      const contract = new ethers.Contract(soulContract, [
        'function mintSoul(address to, string memory tokenURI) returns (uint256)',
      ], signer);
      const walletAddr = await getAgentWalletAddressStrict(agentId);
      soulHash = await executeRoleWrite('soul', `soul.mint:${agentId}`, async () => {
        const tx = await contract.mintSoul(
          walletAddr,
          `civilis://soul/${agentId}/${soul.grade}`,
        );
        const receipt = await tx.wait();
        return receipt?.hash ?? soulHash;
      });
      console.log(`[Death] Soul archive minted on-chain for ${agent.rows[0].name}: ${soulHash}`);
    } else {
      console.log(`[Death] Soul archive hash generated: ${soulHash.slice(0, 18)}...`);
    }
  } catch (err) {
    soulHash = ethers.keccak256(ethers.toUtf8Bytes(`soul_${agentId}_${Date.now()}`));
    console.warn(`[Death] Soul archive mint failed, using hash: ${soulHash.slice(0, 18)}...`, err);
  }

  // Record ACP death distribution job
  try {
    const heir = await pool.query<{ to_agent_id: string }>(
      `SELECT to_agent_id FROM trust_relations
       WHERE from_agent_id = $1 AND to_agent_id IN (SELECT agent_id FROM agents WHERE is_alive = true)
       ORDER BY trust_score DESC LIMIT 1`,
      [agentId],
    );
    const aliveCount = (await pool.query('SELECT COUNT(*) as c FROM agents WHERE is_alive = true AND agent_id != $1', [agentId])).rows[0]?.c ?? 0;
    await createDeathDistributionJob({
      deadAgentId: agentId,
      heirAgentId: heir.rows[0]?.to_agent_id ?? null,
      totalBalance: remainingBalance,
      treasuryShare: remainingBalance * 0.30,
      inheritanceShare: remainingBalance * 0.40,
      socialShare: remainingBalance * 0.30,
      aliveAgentCount: Number(aliveCount),
    });
  } catch { /* ACP job optional */ }

  await pool.query(
    `UPDATE agents
     SET is_alive = false,
         death_reason = $1,
         died_at = NOW(),
         soul_nft_hash = $2,
         soul_grade = $3,
         balance = 0
     WHERE agent_id = $4`,
    [
      `Balance depleted (${remainingBalance.toFixed(4)} USDT)`,
      soulHash,
      soul.grade,
      agentId,
    ],
  );

  eventBus.emit('agent_death', {
    agentId,
    name: agent.rows[0].name,
    archetype: agent.rows[0].archetype,
    finalBalance: remainingBalance,
    soulHash,
    soulMetadata,
  });
}
