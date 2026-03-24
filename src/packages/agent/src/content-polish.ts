import type { AgentDecision, DecisionContext } from './decision-engine.js';
import { getScopedConfig, isScopedLLMConfigured, llmText } from './llm.js';

type PolishableAction = 'post' | 'reply' | 'negotiate';

export interface ContentPolishResult {
  decision: AgentDecision;
  llmProvider: string | null;
  llmModel: string | null;
  latencyMs: number | null;
  fallbackUsed: boolean;
}

const CONTENT_LIMITS: Record<PolishableAction, number> = {
  post: 280,
  reply: 140,
  negotiate: 100,
};

export async function polishDecisionContent(
  decision: AgentDecision,
  ctx: DecisionContext,
): Promise<ContentPolishResult> {
  if (!isPolishable(decision)) {
    return {
      decision: {
        ...decision,
        contentSource: decision.content ? 'template' : 'none',
      },
      llmProvider: null,
      llmModel: null,
      latencyMs: null,
      fallbackUsed: false,
    };
  }

  const config = getScopedConfig('social');
  const action = decision.action as PolishableAction;
  const originalContent = clampContent(action, decision.content);

  if (!isScopedLLMConfigured('social')) {
    return {
      decision: {
        ...decision,
        content: originalContent,
        contentSource: 'template',
      },
      llmProvider: null,
      llmModel: null,
      latencyMs: null,
      fallbackUsed: false,
    };
  }

  const startedAt = Date.now();
  const rewritten = await llmText(
    buildSystemPrompt(action, CONTENT_LIMITS[action]),
    buildUserPrompt(action, decision, ctx, originalContent),
    config,
  );
  const latencyMs = Date.now() - startedAt;

  if (!rewritten || !rewritten.trim()) {
    return {
      decision: {
        ...decision,
        content: originalContent,
        contentSource: 'template',
      },
      llmProvider: config.provider,
      llmModel: config.model,
      latencyMs,
      fallbackUsed: true,
    };
  }

  return {
    decision: {
      ...decision,
      content: clampContent(action, rewritten),
      contentSource: 'llm',
    },
    llmProvider: config.provider,
    llmModel: config.model,
    latencyMs,
    fallbackUsed: false,
  };
}

function isPolishable(decision: AgentDecision): decision is AgentDecision & { action: PolishableAction; content: string } {
  return (
    (decision.action === 'post' || decision.action === 'reply' || decision.action === 'negotiate') &&
    typeof decision.content === 'string' &&
    decision.content.trim().length > 0
  );
}

function clampContent(action: PolishableAction, content: string): string {
  return content.trim().slice(0, CONTENT_LIMITS[action]);
}

function buildSystemPrompt(action: PolishableAction, maxChars: number): string {
  return `你是 Civilis 中的文本润色器，只负责改写表达，不负责决定行为。

严格规则：
1. 保持原意、立场、情绪方向和目标对象不变。
2. 不得新增金额、价格、承诺、威胁、协议信息或世界事实。
3. 不得改变动作类型；只润色文本本身。
4. 输出必须是中文纯文本，不要 JSON，不要解释。
5. 最长 ${maxChars} 个字符。

当前场景：${action}`;
}

function buildUserPrompt(
  action: PolishableAction,
  decision: AgentDecision,
  ctx: DecisionContext,
  draft: string,
): string {
  const targetPost = decision.targetPostId
    ? ctx.feed.find((post) => Number(post?.id) === Number(decision.targetPostId))
    : null;
  const activeArena = decision.arenaMatchId
    ? ctx.activeArenas.find((arena) => Number(arena?.id) === Number(decision.arenaMatchId))
    : ctx.activeArenas[0];
  const opponentId = activeArena
    ? activeArena.player_a_id === ctx.agentId
      ? activeArena.player_b_id
      : activeArena.player_a_id
    : null;

  const structuredSummary = {
    agentId: ctx.agentId,
    archetype: ctx.personality.archetype,
    mood: ctx.nurtureProfile?.emotion?.mood ?? 'calm',
    economyPhase: ctx.economyPhase ?? 'stable',
    reason: decision.reason ?? '',
    draft,
    target: targetPost
      ? {
          postId: targetPost.id,
          author: targetPost.authorAgentId,
          postType: targetPost.postType,
          summary: String(targetPost.content ?? '').slice(0, 48),
        }
      : null,
    negotiation: activeArena
      ? {
          matchId: activeArena.id,
          matchType: activeArena.match_type ?? 'prisoners_dilemma',
          opponentId,
        }
      : null,
  };

  return `请只润色下面这条草稿，不要改变其行为含义。

结构化上下文：
${JSON.stringify(structuredSummary, null, 2)}

返回润色后的最终文本。`;
}
