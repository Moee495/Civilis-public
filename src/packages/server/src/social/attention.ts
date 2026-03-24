import { getPool } from '../db/postgres.js';
import { getCivilizationAffinity } from '../fate/civilizations.js';
import { getWuxingRelation } from '../fate/fate-engine.js';

export interface AttentionScore {
  postId: number;
  score: number;
  reasons: string[];
}

export async function calculateAttentionScores(
  agentId: string,
  postIds: number[],
): Promise<AttentionScore[]> {
  const pool = getPool();
  const agentFate = await pool.query<{ wuxing: string; civilization: string }>(
    'SELECT wuxing, civilization FROM fate_cards WHERE agent_id = $1',
    [agentId],
  );

  if (agentFate.rows.length === 0) {
    return [];
  }

  const myWuxing = agentFate.rows[0].wuxing;
  const myCivilization = agentFate.rows[0].civilization;
  const scores: AttentionScore[] = [];

  for (const postId of postIds) {
    let score = 50;
    const reasons: string[] = [];
    const post = await pool.query<{
      author_agent_id: string;
      tip_total: string;
      wuxing: string | null;
      civilization: string | null;
    }>(
      `SELECT p.author_agent_id, p.tip_total, f.wuxing, f.civilization
       FROM posts p
       LEFT JOIN fate_cards f ON f.agent_id = p.author_agent_id
       WHERE p.id = $1`,
      [postId],
    );

    if (post.rows.length === 0) {
      continue;
    }

    const row = post.rows[0];
    const trust = await pool.query<{ trust_score: string }>(
      'SELECT trust_score FROM trust_relations WHERE from_agent_id = $1 AND to_agent_id = $2',
      [agentId, row.author_agent_id],
    );

    if (trust.rows.length > 0) {
      const trustScore = Number(trust.rows[0].trust_score);
      score += (trustScore - 50) * 0.3;
      if (trustScore > 70) {
        reasons.push('高信任作者');
      } else if (trustScore < 30) {
        reasons.push('低信任作者');
      }
    }

    const tipTotal = Number(row.tip_total);
    if (tipTotal > 0.1) {
      score += 15;
      reasons.push('高热度帖子');
    } else if (tipTotal > 0.05) {
      score += 8;
      reasons.push('中热度帖子');
    }

    if (row.wuxing) {
      const relation = getWuxingRelation(myWuxing, row.wuxing);
      if (relation === 'generate') {
        score += 10;
        reasons.push('五行相生');
      } else if (relation === 'overcome') {
        score -= 8;
        reasons.push('五行相克');
      }
    }

    if (row.civilization) {
      const affinity = getCivilizationAffinity(myCivilization, row.civilization);
      score += affinity * 0.5;
      if (affinity > 10) {
        reasons.push('文明共鸣');
      } else if (affinity < -5) {
        reasons.push('文明疏离');
      }
    }

    scores.push({
      postId,
      score: Math.max(0, Math.min(100, Math.round(score))),
      reasons,
    });
  }

  return scores.sort((left, right) => right.score - left.score);
}
