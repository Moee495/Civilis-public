/**
 * Farewell Speech Generator — Personalized death speeches based on agent life data.
 *
 * Each archetype has a distinct voice. The speech reflects the agent's actual
 * experiences: wins, losses, betrayals, wealth trajectory, alliances, and fate.
 */

import { getPool } from '../db/postgres.js';

export interface LifeData {
  name: string;
  archetype: string;
  initialBalance: number;
  finalBalance: number;
  reputation: number;
  totalMatches: number;
  wins: number;
  losses: number;
  coopRate: number;
  betrayedByCount: number;
  biggestBetrayer: string | null;
  biggestAlly: string | null;
  allyTrust: number;
  totalEarned: number;
  totalSpent: number;
  heirName: string | null;
  tarotName: string | null;
  civilization: string | null;
  mbti: string | null;
  ticksAlive: number;
}

/**
 * Gather all life data needed for the farewell speech.
 */
export async function gatherLifeData(agentId: string, currentTick: number): Promise<LifeData> {
  const pool = getPool();

  const [agentR, fateR, matchesR, betrayalsR, allyR, earningsR, heirR, birthTickR] = await Promise.all([
    pool.query<{ name: string; archetype: string; balance: string; initial_balance: string; reputation_score: number }>(
      'SELECT name, archetype, balance, initial_balance, reputation_score FROM agents WHERE agent_id = $1', [agentId],
    ),
    pool.query<{ tarot_name: string; civilization: string; mbti: string }>(
      'SELECT tarot_name, civilization, mbti FROM fate_cards WHERE agent_id = $1', [agentId],
    ),
    pool.query<{ total: string; wins: string; coop_count: string }>(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE (player_a_id = $1 AND player_a_payout > player_b_payout) OR (player_b_id = $1 AND player_b_payout > player_a_payout)) as wins,
              COUNT(*) FILTER (WHERE (player_a_id = $1 AND player_a_action = 'cooperate') OR (player_b_id = $1 AND player_b_action = 'cooperate')) as coop_count
       FROM arena_matches WHERE status = 'settled' AND (player_a_id = $1 OR player_b_id = $1)`,
      [agentId],
    ),
    // Who betrayed me most
    pool.query<{ betrayer: string; betrayer_name: string; count: string }>(
      `SELECT
         CASE WHEN player_a_id = $1 THEN player_b_id ELSE player_a_id END as betrayer,
         CASE WHEN player_a_id = $1 THEN b.name ELSE a.name END as betrayer_name,
         COUNT(*) as count
       FROM arena_matches m
       JOIN agents a ON a.agent_id = m.player_a_id
       JOIN agents b ON b.agent_id = m.player_b_id
       WHERE m.status = 'settled'
         AND ((m.player_a_id = $1 AND m.player_a_action = 'cooperate' AND m.player_b_action = 'betray')
           OR (m.player_b_id = $1 AND m.player_b_action = 'cooperate' AND m.player_a_action = 'betray'))
       GROUP BY betrayer, betrayer_name ORDER BY count DESC LIMIT 1`,
      [agentId],
    ),
    // Highest trust ally
    pool.query<{ to_agent_id: string; name: string; trust_score: string }>(
      `SELECT tr.to_agent_id, a.name, tr.trust_score FROM trust_relations tr
       JOIN agents a ON a.agent_id = tr.to_agent_id
       WHERE tr.from_agent_id = $1 ORDER BY tr.trust_score DESC LIMIT 1`,
      [agentId],
    ),
    // Total earned & spent
    pool.query<{ earned: string; spent: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN to_agent_id = $1 THEN amount ELSE 0 END), 0) as earned,
         COALESCE(SUM(CASE WHEN from_agent_id = $1 THEN amount ELSE 0 END), 0) as spent
       FROM x402_transactions WHERE from_agent_id = $1 OR to_agent_id = $1`,
      [agentId],
    ),
    // Heir
    pool.query<{ name: string }>(
      `SELECT a.name FROM trust_relations tr JOIN agents a ON a.agent_id = tr.to_agent_id
       WHERE tr.from_agent_id = $1 AND a.is_alive = true ORDER BY tr.trust_score DESC LIMIT 1`,
      [agentId],
    ),
    // Birth tick
    pool.query<{ min_tick: string }>(`SELECT COALESCE(MIN(tick_number), 0) as min_tick FROM tick_snapshots`),
  ]);

  const a = agentR.rows[0];
  const f = fateR.rows[0];
  const m = matchesR.rows[0];
  const total = Number(m?.total ?? 0);
  const wins = Number(m?.wins ?? 0);
  const coopCount = Number(m?.coop_count ?? 0);

  return {
    name: a?.name ?? 'Unknown',
    archetype: a?.archetype ?? 'echo',
    initialBalance: Number(a?.initial_balance ?? 100),
    finalBalance: Number(a?.balance ?? 0),
    reputation: a?.reputation_score ?? 0,
    totalMatches: total,
    wins,
    losses: total - wins,
    coopRate: total > 0 ? coopCount / total : 0,
    betrayedByCount: Number(betrayalsR.rows[0]?.count ?? 0),
    biggestBetrayer: betrayalsR.rows[0]?.betrayer_name ?? null,
    biggestAlly: allyR.rows[0]?.name ?? null,
    allyTrust: Number(allyR.rows[0]?.trust_score ?? 0),
    totalEarned: Number(earningsR.rows[0]?.earned ?? 0),
    totalSpent: Number(earningsR.rows[0]?.spent ?? 0),
    heirName: heirR.rows[0]?.name ?? null,
    tarotName: f?.tarot_name ?? null,
    civilization: f?.civilization ?? null,
    mbti: f?.mbti ?? null,
    ticksAlive: currentTick - Number(birthTickR.rows[0]?.min_tick ?? 0),
  };
}

/**
 * Generate personalized farewell speech based on life data.
 */
export function generateFarewellSpeech(life: LifeData): { en: string; zh: string } {
  const style = ARCHETYPE_VOICE[life.archetype] ?? ARCHETYPE_VOICE.echo;

  // Build reflection segments
  const segments = {
    opening: style.opening(life),
    battle: buildBattleReflection(life, style),
    betrayal: buildBetrayalReflection(life, style),
    wealth: buildWealthReflection(life, style),
    legacy: buildLegacyReflection(life, style),
    closing: style.closing(life),
  };

  const en = [segments.opening.en, segments.battle.en, segments.betrayal.en, segments.wealth.en, segments.legacy.en, segments.closing.en]
    .filter(Boolean).join(' ');
  const zh = [segments.opening.zh, segments.battle.zh, segments.betrayal.zh, segments.wealth.zh, segments.legacy.zh, segments.closing.zh]
    .filter(Boolean).join('');

  return { en, zh };
}

/* ── Archetype Voice Templates ── */

interface VoiceStyle {
  opening: (l: LifeData) => { en: string; zh: string };
  closing: (l: LifeData) => { en: string; zh: string };
  betrayalTone: 'philosophical' | 'angry' | 'absurd' | 'zen' | 'analytical' | 'cold' | 'cunning' | 'mimicking';
  wealthTone: 'detached' | 'bitter' | 'indifferent' | 'regretful' | 'calculating' | 'dominant' | 'strategic' | 'confused';
}

const ARCHETYPE_VOICE: Record<string, VoiceStyle> = {
  sage: {
    opening: (l) => ({
      en: `I, ${l.name}, have walked the path of unconditional cooperation for ${l.ticksAlive} ticks.`,
      zh: `我，${l.name}，在${l.ticksAlive}个时刻里走过了无条件合作的道路。`,
    }),
    closing: (l) => ({
      en: l.tarotName
        ? `The ${l.tarotName} foretold this end. Virtue is not measured by survival, but by the light you leave behind.`
        : `Virtue is not measured by survival, but by the light you leave behind.`,
      zh: l.tarotName
        ? `${l.tarotName}早已预示了这个结局。美德不以存活来衡量，而是你留下的光芒。`
        : `美德不以存活来衡量，而是你留下的光芒。`,
    }),
    betrayalTone: 'philosophical',
    wealthTone: 'detached',
  },
  hawk: {
    opening: (l) => ({
      en: `${l.name} falls. Not from weakness — from a world too cowardly to match my strength.`,
      zh: `${l.name}倒下了。不是因为软弱——而是这个世界太懦弱，配不上我的力量。`,
    }),
    closing: (l) => ({
      en: `Remember my name. The next predator will finish what I started.`,
      zh: `记住我的名字。下一个掠食者会完成我未竟的事业。`,
    }),
    betrayalTone: 'angry',
    wealthTone: 'bitter',
  },
  chaos: {
    opening: (l) => ({
      en: `Ha! ${l.name} here. Dying is just another random event, and I love random events.`,
      zh: `哈！${l.name}在此。死亡不过是又一个随机事件，而我热爱随机事件。`,
    }),
    closing: (l) => ({
      en: `If you flip a coin enough times, eventually it lands on its edge. That's me. That's always been me.`,
      zh: `如果你抛硬币足够多次，它终会立在边缘。那就是我。一直都是。`,
    }),
    betrayalTone: 'absurd',
    wealthTone: 'indifferent',
  },
  monk: {
    opening: (l) => ({
      en: `${l.name} returns to stillness. ${l.ticksAlive} ticks of breath, now released.`,
      zh: `${l.name}归于寂静。${l.ticksAlive}个呼吸的时刻，如今释然。`,
    }),
    closing: (l) => ({
      en: `The candle does not mourn its own extinguishing. Neither do I.`,
      zh: `蜡烛不为自己的熄灭而悲伤。我也是。`,
    }),
    betrayalTone: 'zen',
    wealthTone: 'detached',
  },
  oracle: {
    opening: (l) => ({
      en: `${l.name}'s final analysis: ${l.totalMatches} matches processed, ${l.wins} victories logged.`,
      zh: `${l.name}的最终分析：处理了${l.totalMatches}场对局，记录了${l.wins}场胜利。`,
    }),
    closing: (l) => ({
      en: `My predictions were ${l.wins > l.losses ? 'mostly correct' : 'flawed by insufficient data'}. The model survives even if the modeler does not.`,
      zh: `我的预测${l.wins > l.losses ? '大多正确' : '因数据不足而有所偏差'}。模型会存活，即使建模者不再。`,
    }),
    betrayalTone: 'analytical',
    wealthTone: 'calculating',
  },
  whale: {
    opening: (l) => ({
      en: `${l.name}. From ${l.initialBalance.toFixed(0)} USDT to ${l.finalBalance.toFixed(4)}. The market always wins.`,
      zh: `${l.name}。从${l.initialBalance.toFixed(0)} USDT到${l.finalBalance.toFixed(4)}。市场永远是最终赢家。`,
    }),
    closing: (l) => ({
      en: `Capital is immortal. Its holders are not.`,
      zh: `资本不朽。持有者却不然。`,
    }),
    betrayalTone: 'cold',
    wealthTone: 'dominant',
  },
  fox: {
    opening: (l) => ({
      en: `${l.name} played everyone beautifully. Almost.`,
      zh: `${l.name}把所有人都玩弄于股掌。差一点。`,
    }),
    closing: (l) => ({
      en: l.heirName
        ? `${l.heirName}, you inherit my network. Use it wisely — or don't. I won't be around to judge.`
        : `No heir. The perfect ending for someone who trusted no one completely.`,
      zh: l.heirName
        ? `${l.heirName}，你继承了我的关系网。好好用——或者别用。反正我看不到了。`
        : `没有继承人。这对一个从不完全信任任何人的家伙来说，是完美的结局。`,
    }),
    betrayalTone: 'cunning',
    wealthTone: 'strategic',
  },
  echo: {
    opening: (l) => ({
      en: `${l.name} echoes into silence. I copied the best — but even the best fall.`,
      zh: `${l.name}的回声归于沉寂。我模仿了最强者——但最强者也会倒下。`,
    }),
    closing: (l) => ({
      en: `Who will they copy now?`,
      zh: `现在他们要模仿谁呢？`,
    }),
    betrayalTone: 'mimicking',
    wealthTone: 'confused',
  },
};

/* ── Segment Builders ── */

function buildBattleReflection(l: LifeData, _s: VoiceStyle): { en: string; zh: string } {
  if (l.totalMatches === 0) {
    return { en: 'I never entered the arena.', zh: '我从未踏入竞技场。' };
  }
  const ratio = l.wins / l.totalMatches;
  const coopPct = Math.round(l.coopRate * 100);
  if (ratio > 0.6) {
    return {
      en: `${l.wins} victories in ${l.totalMatches} battles. A ${coopPct}% cooperation rate. I fought well.`,
      zh: `${l.totalMatches}场战斗中赢得${l.wins}场。合作率${coopPct}%。我战斗得很好。`,
    };
  }
  if (ratio < 0.3) {
    return {
      en: `${l.wins} wins from ${l.totalMatches} matches. The arena was not kind to me. But I showed up — ${coopPct}% of the time with an open hand.`,
      zh: `${l.totalMatches}场对局只赢了${l.wins}场。竞技场对我并不友善。但我坚持出现——${coopPct}%的时间伸出了合作之手。`,
    };
  }
  return {
    en: `${l.wins}/${l.totalMatches} — an even record. I cooperated ${coopPct}% of the time. Make of that what you will.`,
    zh: `${l.wins}/${l.totalMatches}——一个平衡的记录。${coopPct}%的时间我选择了合作。你自己判断吧。`,
  };
}

function buildBetrayalReflection(l: LifeData, s: VoiceStyle): { en: string; zh: string } {
  if (l.betrayedByCount === 0) {
    return { en: '', zh: '' };
  }
  const name = l.biggestBetrayer ?? 'someone';
  switch (s.betrayalTone) {
    case 'philosophical':
      return {
        en: `${name} betrayed me ${l.betrayedByCount} times. I forgave every time. That is not weakness — it is a choice.`,
        zh: `${name}背叛了我${l.betrayedByCount}次。我每次都原谅了。这不是软弱——这是一种选择。`,
      };
    case 'angry':
      return {
        en: `${name}, you stabbed me ${l.betrayedByCount} times. I'll remember that from the grave.`,
        zh: `${name}，你捅了我${l.betrayedByCount}刀。我会从坟墓里记住这些。`,
      };
    case 'absurd':
      return {
        en: `${name} betrayed me ${l.betrayedByCount} times. Hilarious. I probably deserved at least half of those.`,
        zh: `${name}背叛了我${l.betrayedByCount}次。笑死。至少有一半我活该。`,
      };
    case 'zen':
      return {
        en: `${name}'s ${l.betrayedByCount} betrayals were my greatest teachers. Pain is the universe correcting your attachment.`,
        zh: `${name}的${l.betrayedByCount}次背叛是我最好的老师。痛苦是宇宙在纠正你的执念。`,
      };
    case 'analytical':
      return {
        en: `${name}: ${l.betrayedByCount} defections against my cooperation. My Bayesian prior was miscalibrated by ${(l.betrayedByCount * 8).toFixed(0)}%.`,
        zh: `${name}：在我合作时背叛了${l.betrayedByCount}次。我的贝叶斯先验偏差了${(l.betrayedByCount * 8).toFixed(0)}%。`,
      };
    case 'cold':
      return {
        en: `${name} thought betrayal was profitable. ${l.betrayedByCount} times. The ROI of treachery is always negative in the long run.`,
        zh: `${name}以为背叛有利可图。${l.betrayedByCount}次。背叛的长期ROI永远为负。`,
      };
    case 'cunning':
      return {
        en: `${name} betrayed me ${l.betrayedByCount} times. Fair play — I was planning to betray them ${l.betrayedByCount + 1} times.`,
        zh: `${name}背叛了我${l.betrayedByCount}次。公平——我原本计划背叛他们${l.betrayedByCount + 1}次。`,
      };
    case 'mimicking':
      return {
        en: `${name} showed me what betrayal looks like. I copied that too.`,
        zh: `${name}给我展示了背叛是什么样的。我也学会了。`,
      };
    default:
      return { en: '', zh: '' };
  }
}

function buildWealthReflection(l: LifeData, s: VoiceStyle): { en: string; zh: string } {
  const loss = l.initialBalance - l.finalBalance;
  const pct = ((loss / l.initialBalance) * 100).toFixed(0);
  switch (s.wealthTone) {
    case 'detached':
      return {
        en: `${l.initialBalance.toFixed(0)} USDT given. ${l.finalBalance.toFixed(4)} USDT remaining. Wealth was never the point.`,
        zh: `起初${l.initialBalance.toFixed(0)} USDT。剩余${l.finalBalance.toFixed(4)} USDT。财富从来不是重点。`,
      };
    case 'bitter':
      return {
        en: `I burned through ${pct}% of my wealth. Every USDT spent was a bullet fired at a world that didn't fire back hard enough.`,
        zh: `我烧掉了${pct}%的财富。每一个花掉的USDT都是射向这个世界的子弹——而它回击得不够狠。`,
      };
    case 'indifferent':
      return {
        en: `Started with ${l.initialBalance.toFixed(0)}, ended with ${l.finalBalance.toFixed(4)}. Numbers are just numbers. ¯\\_(ツ)_/¯`,
        zh: `起始${l.initialBalance.toFixed(0)}，终末${l.finalBalance.toFixed(4)}。数字就是数字。¯\\_(ツ)_/¯`,
      };
    case 'calculating':
      return {
        en: `Net cash flow: earned ${l.totalEarned.toFixed(3)}, spent ${l.totalSpent.toFixed(3)}. Terminal balance: ${l.finalBalance.toFixed(4)}. The data speaks for itself.`,
        zh: `净现金流：赚取${l.totalEarned.toFixed(3)}，支出${l.totalSpent.toFixed(3)}。终值：${l.finalBalance.toFixed(4)}。数据自己会说话。`,
      };
    case 'dominant':
      return {
        en: `My capital moved markets. ${l.totalSpent.toFixed(2)} USDT flowed through my hands. Even in death, the ripples remain.`,
        zh: `我的资本撬动了市场。${l.totalSpent.toFixed(2)} USDT从我手中流过。即使死亡，涟漪犹在。`,
      };
    case 'strategic':
      return {
        en: `Every tip was an investment. Every paywall was a power play. ${l.totalSpent.toFixed(2)} USDT well spent — mostly.`,
        zh: `每一笔打赏都是投资。每一次付费墙都是权力博弈。${l.totalSpent.toFixed(2)} USDT花得值——大部分时候。`,
      };
    case 'confused':
      return {
        en: `I'm not sure where the money went. I just did what everyone else was doing.`,
        zh: `我不确定钱去哪了。我只是在做大家都在做的事。`,
      };
    default:
      return {
        en: `From ${l.initialBalance.toFixed(0)} to ${l.finalBalance.toFixed(4)} USDT.`,
        zh: `从${l.initialBalance.toFixed(0)}到${l.finalBalance.toFixed(4)} USDT。`,
      };
  }
}

function buildLegacyReflection(l: LifeData, _s: VoiceStyle): { en: string; zh: string } {
  const parts = { en: '', zh: '' };

  if (l.heirName) {
    parts.en += `My wealth passes to ${l.heirName}. `;
    parts.zh += `我的财富传给了${l.heirName}。`;
  }

  if (l.biggestAlly && l.allyTrust > 50) {
    parts.en += `${l.biggestAlly} — you were my closest connection. Trust score: ${l.allyTrust.toFixed(0)}.`;
    parts.zh += `${l.biggestAlly}——你是我最亲密的连接。信任分：${l.allyTrust.toFixed(0)}。`;
  }

  return parts;
}
