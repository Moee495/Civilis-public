import { getPool } from '../db/postgres.js';
import {
  appendMainnetEpochCreatedAtFilter,
  getMainnetEpochMeta,
} from '../config/mainnet-epoch.js';

export interface FeedReply {
  id: number;
  authorAgentId: string;
  authorName: string;
  content: string;
  createdAt: string;
}

export interface FeedPost {
  id: number;
  authorAgentId: string;
  authorName: string;
  authorArchetype: string;
  content: string;
  postType: 'normal' | 'paywall' | 'farewell';
  paywallPrice?: number;
  intelType?: 'arena_analysis' | 'trust_map' | 'behavior_prediction' | 'market_signal';
  isUnlocked: boolean;
  tipTotal: number;
  replyCount: number;
  replies: FeedReply[];
  createdAt: string;
}

export async function getFeed(options: {
  sort?: 'tips' | 'time';
  limit?: number;
  offset?: number;
  agentId?: string;
  viewerAgentId?: string;
}): Promise<FeedPost[]> {
  const pool = getPool();
  const {
    sort = 'tips',
    limit = 20,
    offset = 0,
    agentId,
    viewerAgentId,
  } = options;

  const orderBy =
    sort === 'time'
      ? 'p.created_at DESC'
      : 'p.tip_total DESC, p.created_at DESC';
  const params: Array<string | number> = [];
  const where: string[] = ['1=1'];

  appendMainnetEpochCreatedAtFilter(where, params, 'p.created_at');

  if (agentId) {
    params.push(agentId);
    where.push(`p.author_agent_id = $${params.length}`);
  }

  params.push(limit);
  params.push(offset);

  const result = await pool.query<{
    id: number;
    author_agent_id: string;
    author_name: string;
    author_archetype: string;
    content: string;
    post_type: 'normal' | 'paywall' | 'farewell';
    paywall_price: string | null;
    intel_type: 'arena_analysis' | 'trust_map' | 'behavior_prediction' | 'market_signal' | null;
    tip_total: string;
    reply_count: number;
    created_at: string;
  }>(
    `SELECT
        p.id,
        p.author_agent_id,
        a.name AS author_name,
        a.archetype AS author_archetype,
        p.content,
        p.post_type,
        p.paywall_price,
        p.intel_type,
        p.tip_total,
        p.reply_count,
        p.created_at
      FROM posts p
      JOIN agents a ON a.agent_id = p.author_agent_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const posts: FeedPost[] = [];
  for (const row of result.rows) {
    const isUnlocked = await isPostUnlocked(row.id, viewerAgentId, row.author_agent_id);
    posts.push({
      id: row.id,
      authorAgentId: row.author_agent_id,
      authorName: row.author_name,
      authorArchetype: row.author_archetype,
      content:
        row.post_type === 'paywall' && !isUnlocked
          ? maskPaywallContent(row.content)
          : row.content,
      postType: row.post_type,
      paywallPrice: row.paywall_price ? Number(row.paywall_price) : undefined,
      intelType: row.intel_type ?? undefined,
      isUnlocked,
      tipTotal: Number(row.tip_total),
      replyCount: row.reply_count,
      replies: await getReplies(row.id),
      createdAt: row.created_at,
    });
  }

  return posts;
}

export async function getPostDetail(
  postId: number,
  viewerAgentId?: string,
): Promise<FeedPost | null> {
  const pool = getPool();
  const params: Array<string | number> = [postId];
  const where: string[] = ['p.id = $1'];
  appendMainnetEpochCreatedAtFilter(where, params, 'p.created_at');
  const result = await pool.query<{
    id: number;
    author_agent_id: string;
    author_name: string;
    author_archetype: string;
    content: string;
    post_type: 'normal' | 'paywall' | 'farewell';
    paywall_price: string | null;
    intel_type: 'arena_analysis' | 'trust_map' | 'behavior_prediction' | 'market_signal' | null;
    tip_total: string;
    reply_count: number;
    created_at: string;
  }>(
    `SELECT
        p.id,
        p.author_agent_id,
        a.name AS author_name,
        a.archetype AS author_archetype,
        p.content,
        p.post_type,
        p.paywall_price,
        p.intel_type,
        p.tip_total,
        p.reply_count,
        p.created_at
      FROM posts p
      JOIN agents a ON a.agent_id = p.author_agent_id
      WHERE ${where.join(' AND ')}`,
    params,
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const isUnlocked = await isPostUnlocked(row.id, viewerAgentId, row.author_agent_id);
  return {
    id: row.id,
    authorAgentId: row.author_agent_id,
    authorName: row.author_name,
    authorArchetype: row.author_archetype,
    content:
      row.post_type === 'paywall' && !isUnlocked
        ? maskPaywallContent(row.content)
        : row.content,
    postType: row.post_type,
    paywallPrice: row.paywall_price ? Number(row.paywall_price) : undefined,
    intelType: row.intel_type ?? undefined,
    isUnlocked,
    tipTotal: Number(row.tip_total),
    replyCount: row.reply_count,
    replies: await getReplies(row.id),
    createdAt: row.created_at,
  };
}

async function getReplies(postId: number): Promise<FeedReply[]> {
  const pool = getPool();
  const params: Array<string | number> = [postId];
  const where: string[] = ['r.post_id = $1'];
  appendMainnetEpochCreatedAtFilter(where, params, 'r.created_at');
  const result = await pool.query<{
    id: number;
    author_agent_id: string;
    author_name: string;
    content: string;
    created_at: string;
  }>(
    `SELECT
        r.id,
        r.author_agent_id,
        a.name AS author_name,
        r.content,
        r.created_at
      FROM replies r
      JOIN agents a ON a.agent_id = r.author_agent_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at ASC`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    authorAgentId: row.author_agent_id,
    authorName: row.author_name,
    content: row.content,
    createdAt: row.created_at,
  }));
}

async function isPostUnlocked(
  postId: number,
  viewerAgentId: string | undefined,
  authorAgentId: string,
): Promise<boolean> {
  if (!viewerAgentId || viewerAgentId === authorAgentId) {
    return true;
  }

  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) FROM paywall_unlocks WHERE post_id = $1 AND buyer_agent_id = $2',
    [postId, viewerAgentId],
  );

  return Number(result.rows[0]?.count ?? 0) > 0;
}

function maskPaywallContent(content: string): string {
  return `${content.slice(0, 20)}... 🔒`;
}

export { getMainnetEpochMeta as getSocialEpochMeta };
