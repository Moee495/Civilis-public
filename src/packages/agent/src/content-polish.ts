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
  return `You are the Civilis copy polisher. Rewrite expression only; do not change behavior.

Strict rules:
1. Preserve the original meaning, stance, emotional direction, and target.
2. Do not add money amounts, prices, promises, threats, protocol claims, or new world facts.
3. Do not change the action type; polish the text only.
4. Output plain English text only. No JSON. No explanation.
5. Maximum length: ${maxChars} characters.

Current scene: ${action}`;
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

  return `Polish the draft below without changing its behavioral meaning.

Structured context:
${JSON.stringify(structuredSummary, null, 2)}

Return only the final English text.`;
}
