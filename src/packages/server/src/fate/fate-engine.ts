import { ethers } from 'ethers';
import { getPool } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { getWorldModifierMultiplier } from '../world/modifiers.js';
import { CIVILIZATIONS, getCivilizationAffinity } from './civilizations.js';
import {
  FateCard,
  FATE_DIMENSIONS,
  MBTI_TYPES,
  TAROT_MAJOR,
  WUXING,
  ZODIAC_SIGNS,
  WuxingName,
} from './fate-card.js';

export const DIVINATION_PRICES: Record<(typeof FATE_DIMENSIONS)[number], number> = {
  mbti: 0.01,
  wuxing: 0.05,
  zodiac: 0.01,
  tarot: 0.1,
  civilization: 1.0,
};

export async function getDivinationPrice(
  dimension: (typeof FATE_DIMENSIONS)[number],
): Promise<number> {
  const multiplier = await getWorldModifierMultiplier({
    domain: 'fate',
    modifierType: 'divination_price_multiplier',
  }).catch(() => 1);

  return Number((DIVINATION_PRICES[dimension] * multiplier).toFixed(6));
}

export async function generateFateCard(
  agentId: string,
  blockHash: string,
  blockNumber: number,
): Promise<FateCard> {
  const pool = getPool();
  const existing = await pool.query('SELECT * FROM fate_cards WHERE agent_id = $1', [
    agentId,
  ]);

  if (existing.rows.length > 0) {
    return mapRowToFateCard(existing.rows[0]);
  }

  const rawSeed = ethers.keccak256(
    ethers.solidityPacked(['bytes32', 'string'], [blockHash, agentId]),
  );
  const hex = rawSeed.slice(2);

  const ei = parseInt(hex.slice(0, 2), 16) % 2 === 0 ? 'E' : 'I';
  const sn = parseInt(hex.slice(2, 4), 16) % 2 === 0 ? 'S' : 'N';
  const tf = parseInt(hex.slice(4, 6), 16) % 2 === 0 ? 'T' : 'F';
  const jp = parseInt(hex.slice(6, 8), 16) % 2 === 0 ? 'J' : 'P';
  const mbti = `${ei}${sn}${tf}${jp}`;

  const wuxing = WUXING[parseInt(hex.slice(8, 10), 16) % WUXING.length];
  const rawScores = [
    parseInt(hex.slice(10, 12), 16),
    parseInt(hex.slice(12, 14), 16),
    parseInt(hex.slice(14, 16), 16),
    parseInt(hex.slice(16, 18), 16),
    parseInt(hex.slice(18, 20), 16),
  ];
  const total = rawScores.reduce((sum, value) => sum + value, 0) || 1;
  const elementDetail = {
    金: Math.round((rawScores[0] / total) * 100),
    木: Math.round((rawScores[1] / total) * 100),
    水: Math.round((rawScores[2] / total) * 100),
    火: Math.round((rawScores[3] / total) * 100),
    土: Math.round((rawScores[4] / total) * 100),
  } as Record<WuxingName, number>;

  const zodiac = ZODIAC_SIGNS[parseInt(hex.slice(20, 22), 16) % ZODIAC_SIGNS.length];
  const tarotMajor =
    parseInt(hex.slice(22, 24), 16) % TAROT_MAJOR.length;
  const tarotName = TAROT_MAJOR[tarotMajor];
  const civilization =
    CIVILIZATIONS[parseInt(hex.slice(24, 26), 16) % CIVILIZATIONS.length].id;

  // Determine initial tarot state from hash bit 128
  const initialTarotState = parseInt(hex.slice(26, 28), 16) % 2 === 0 ? 'upright' : 'reversed';

  await pool.query(
    `INSERT INTO fate_cards
      (agent_id, block_hash, block_number, mbti, wuxing, zodiac, tarot_major, tarot_name, civilization, element_detail, raw_seed, initial_tarot_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      agentId,
      blockHash,
      blockNumber,
      mbti,
      wuxing,
      zodiac,
      tarotMajor,
      tarotName,
      civilization,
      JSON.stringify(elementDetail),
      rawSeed,
      initialTarotState,
    ],
  );

  const card: FateCard = {
    agentId,
    blockHash,
    blockNumber,
    mbti: MBTI_TYPES.includes(mbti as (typeof MBTI_TYPES)[number]) ? mbti : 'INTJ',
    wuxing,
    zodiac,
    tarotMajor,
    tarotName,
    civilization,
    elementDetail,
    rawSeed,
    isRevealed: false,
    revealedDimensions: [],
  };

  eventBus.emit('fate_generated', {
    agentId,
    mbti: card.mbti,
    wuxing: card.wuxing,
    civilization: card.civilization,
  });

  return card;
}

export async function getFateCard(
  agentId: string,
  viewerPaid: boolean = false,
): Promise<Partial<FateCard>> {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM fate_cards WHERE agent_id = $1', [
    agentId,
  ]);

  if (result.rows.length === 0) {
    return {};
  }

  const card = mapRowToFateCard(result.rows[0]);
  if (viewerPaid || card.isRevealed) {
    return card;
  }

  const partial: Partial<FateCard> = {
    agentId,
    isRevealed: false,
    revealedDimensions: card.revealedDimensions,
  };

  for (const dimension of card.revealedDimensions) {
    switch (dimension) {
      case 'mbti':
        partial.mbti = card.mbti;
        break;
      case 'wuxing':
        partial.wuxing = card.wuxing;
        partial.elementDetail = card.elementDetail;
        break;
      case 'zodiac':
        partial.zodiac = card.zodiac;
        break;
      case 'tarot':
        partial.tarotMajor = card.tarotMajor;
        partial.tarotName = card.tarotName;
        break;
      case 'civilization':
        partial.civilization = card.civilization;
        break;
      default:
        break;
    }
  }

  return partial;
}

export async function revealDimension(
  agentId: string,
  dimension: (typeof FATE_DIMENSIONS)[number],
): Promise<{ revealed: boolean; price: number }> {
  const pool = getPool();
  const card = await getFateCard(agentId, true);
  const price = await getDivinationPrice(dimension);
  const revealedDimensions = new Set(card.revealedDimensions ?? []);

  if (revealedDimensions.has(dimension)) {
    return {
      revealed: false,
      price,
    };
  }

  revealedDimensions.add(dimension);
  await pool.query(
    `UPDATE fate_cards
     SET revealed_dimensions = $1,
         is_revealed = $2
     WHERE agent_id = $3`,
    [
      JSON.stringify(Array.from(revealedDimensions)),
      revealedDimensions.size >= FATE_DIMENSIONS.length,
      agentId,
    ],
  );

  eventBus.emit('fate_revealed', {
    agentId,
    dimension,
  });

  return {
    revealed: true,
    price,
  };
}

export function getWuxingRelation(
  a: string,
  b: string,
): 'generate' | 'overcome' | 'neutral' {
  const generate: Record<string, string> = {
    木: '火',
    火: '土',
    土: '金',
    金: '水',
    水: '木',
  };
  const overcome: Record<string, string> = {
    木: '土',
    土: '水',
    水: '火',
    火: '金',
    金: '木',
  };

  if (generate[a] === b) {
    return 'generate';
  }
  if (overcome[a] === b) {
    return 'overcome';
  }
  return 'neutral';
}

export async function getFateRelation(agentId: string, targetId: string): Promise<{
  wuxingRelation: 'generate' | 'overcome' | 'neutral';
  civilizationAffinity: number;
}> {
  const pool = getPool();
  const result = await pool.query<{
    agent_id: string;
    wuxing: string;
    civilization: string;
  }>(
    'SELECT agent_id, wuxing, civilization FROM fate_cards WHERE agent_id = ANY($1)',
    [[agentId, targetId]],
  );

  const source = result.rows.find((row) => row.agent_id === agentId);
  const target = result.rows.find((row) => row.agent_id === targetId);

  if (!source || !target) {
    return {
      wuxingRelation: 'neutral',
      civilizationAffinity: 0,
    };
  }

  return {
    wuxingRelation: getWuxingRelation(source.wuxing, target.wuxing),
    civilizationAffinity: getCivilizationAffinity(
      source.civilization,
      target.civilization,
    ),
  };
}

/**
 * Get the actual value of a specific fate dimension for an agent.
 * Returns the raw value from the fate card (always the true value, not masked).
 */
export async function getDimensionValue(
  agentId: string,
  dimension: string,
): Promise<string | null> {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM fate_cards WHERE agent_id = $1', [agentId]);
  if (result.rows.length === 0) return null;

  const card = mapRowToFateCard(result.rows[0]);
  switch (dimension) {
    case 'mbti':
      return card.mbti;
    case 'wuxing':
      return card.wuxing;
    case 'zodiac':
      return card.zodiac;
    case 'tarot':
      return card.tarotName;
    case 'civilization':
      return card.civilization;
    default:
      return null;
  }
}

/**
 * Check if enough agents know a dimension that it should become public.
 * Threshold: if knower_count >= 3, the dimension becomes publicly revealed.
 * Returns true if the dimension was auto-revealed (crossed threshold).
 */
const PUBLIC_THRESHOLD = 3;

export async function checkPublicThreshold(
  subjectAgentId: string,
  dimension: string,
): Promise<boolean> {
  const pool = getPool();
  const countResult = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM intel_records
     WHERE subject_agent_id = $1 AND dimension = $2`,
    [subjectAgentId, dimension],
  );
  const knowerCount = Number(countResult.rows[0]?.cnt ?? 0);

  if (knowerCount >= PUBLIC_THRESHOLD) {
    // Auto-reveal this dimension on the fate card
    const card = await getFateCard(subjectAgentId, true);
    const revealed = new Set(card.revealedDimensions ?? []);
    if (!revealed.has(dimension)) {
      revealed.add(dimension);
      await pool.query(
        `UPDATE fate_cards
         SET revealed_dimensions = $1,
             is_revealed = $2
         WHERE agent_id = $3`,
        [
          JSON.stringify(Array.from(revealed)),
          revealed.size >= FATE_DIMENSIONS.length,
          subjectAgentId,
        ],
      );
      eventBus.emit('intel_public_threshold', {
        subjectAgentId,
        dimension,
        knowerCount,
      });
      return true;
    }
  }
  return false;
}

/**
 * Get the number of agents who know a specific dimension about a subject.
 */
export async function getKnowerCount(
  subjectAgentId: string,
  dimension: string,
): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM intel_records
     WHERE subject_agent_id = $1 AND dimension = $2`,
    [subjectAgentId, dimension],
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

/**
 * Dynamically compute tarot state based on recent arena performance.
 * - >= 3 settled matches in recent 20 ticks: win rate >= 50% → upright, < 50% → reversed
 * - < 3 matches: use initial state from hash
 */
export async function computeDynamicTarotState(
  agentId: string,
  initialState: 'upright' | 'reversed' = 'upright',
): Promise<'upright' | 'reversed'> {
  const pool = getPool();

  const result = await pool.query<{ total: string; wins: string }>(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (
         WHERE (player_a_id = $1 AND player_a_payout > player_b_payout)
            OR (player_b_id = $1 AND player_b_payout > player_a_payout)
       ) as wins
     FROM arena_matches
     WHERE status = 'settled'
       AND (player_a_id = $1 OR player_b_id = $1)
       AND settled_at >= NOW() - INTERVAL '20 minutes'`,
    [agentId],
  );

  const total = Number(result.rows[0]?.total ?? 0);
  const wins = Number(result.rows[0]?.wins ?? 0);

  // Not enough recent history → use initial state
  if (total < 3) {
    return initialState;
  }

  return (wins / total) >= 0.5 ? 'upright' : 'reversed';
}

/**
 * 获取 agent 已通过 Intel Market 购买/间谍/自揭露的对手命运维度。
 * 未购买的维度不返回，调用方应视为未知。
 */
export async function getKnownOpponentFate(
  viewerId: string,
  opponentId: string,
): Promise<Partial<FateCard>> {
  const pool = getPool();

  // 查询 viewer 已知的关于 opponent 的 intel 维度
  const purchased = await pool.query<{ dimension: string }>(
    `SELECT DISTINCT dimension FROM intel_records
     WHERE knower_agent_id = $1 AND subject_agent_id = $2 AND dimension IS NOT NULL`,
    [viewerId, opponentId],
  );

  const knownDimensions = new Set(purchased.rows.map(r => r.dimension));

  // 如果没有已知任何维度，返回空对象
  if (knownDimensions.size === 0) {
    return {};
  }

  // 加载对手完整 fate card
  const fullCard = await getFateCard(opponentId, true);

  // 只返回已知的维度
  const filtered: Partial<FateCard> = { agentId: opponentId };
  if (knownDimensions.has('mbti')) filtered.mbti = fullCard.mbti;
  if (knownDimensions.has('wuxing')) {
    filtered.wuxing = fullCard.wuxing;
    filtered.elementDetail = fullCard.elementDetail;
  }
  if (knownDimensions.has('zodiac')) filtered.zodiac = fullCard.zodiac;
  if (knownDimensions.has('tarot')) {
    filtered.tarotName = fullCard.tarotName;
    filtered.tarotMajor = fullCard.tarotMajor;
  }
  if (knownDimensions.has('civilization')) filtered.civilization = fullCard.civilization;

  return filtered;
}

function mapRowToFateCard(row: Record<string, unknown>): FateCard {
  return {
    agentId: String(row.agent_id),
    blockHash: String(row.block_hash),
    blockNumber: Number(row.block_number),
    mbti: String(row.mbti),
    wuxing: String(row.wuxing) as WuxingName,
    zodiac: String(row.zodiac),
    tarotMajor: Number(row.tarot_major),
    tarotName: String(row.tarot_name),
    civilization: String(row.civilization),
    elementDetail: row.element_detail as Record<WuxingName, number>,
    rawSeed: String(row.raw_seed),
    isRevealed: Boolean(row.is_revealed),
    revealedDimensions: Array.isArray(row.revealed_dimensions)
      ? (row.revealed_dimensions as string[])
      : [],
    initialTarotState: (row.initial_tarot_state as 'upright' | 'reversed') ?? 'upright',
    createdAt: typeof row.created_at === 'string' ? row.created_at : undefined,
  };
}
