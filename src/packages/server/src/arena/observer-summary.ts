import { llmText } from '../llm/text.js';

interface ArenaMatchLike {
  id: number;
  match_type?: string | null;
  player_a_id: string;
  player_b_id: string;
  player_a_action?: string | null;
  player_b_action?: string | null;
  max_rounds?: number | null;
  total_rounds?: number | null;
  current_round?: number | null;
  continue_probability?: string | number | null;
  status: string;
}

interface ArenaRoundLike {
  round_number: number;
  player_a_action?: string | null;
  player_b_action?: string | null;
  outcome?: string | null;
}

interface NegotiationMessageLike {
  id: number;
  message_type?: string | null;
}

export interface ArenaDecisionTraceRow {
  id: number;
  agent_id: string;
  agent_name?: string | null;
  agent_archetype?: string | null;
  tick_number: number;
  scene: string;
  action: string;
  target_ref?: string | null;
  decision_source: string;
  content_source: string;
  reason_summary?: string | null;
  template_content?: string | null;
  final_content?: string | null;
  llm_provider?: string | null;
  llm_model?: string | null;
  latency_ms?: number | null;
  fallback_used?: boolean;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

export interface ArenaObserverSummary {
  source: 'template' | 'llm';
  headline: { zh: string; en: string };
  summary: { zh: string; en: string };
  insight: { zh: string; en: string };
  facts: {
    status: string;
    matchType: string;
    completedRounds: number;
    configuredMaxRounds: number;
    betrayalRounds: number;
    negotiationMessages: number;
    decisionTraces: number;
    negotiationTraces: number;
    lockedDecisionTraces: number;
    llmContentTraces: number;
    templateContentTraces: number;
    dominantDecisionSource: 'heuristic' | 'mixed' | 'unknown';
    lastOutcome: string | null;
  };
}

interface SummaryTemplate {
  headlineZh: string;
  headlineEn: string;
  summaryZh: string;
  summaryEn: string;
  insightZh: string;
  insightEn: string;
}

const MAX_HEADLINE = 56;
const MAX_SUMMARY = 220;
const MAX_INSIGHT = 220;
const ALLOW_SYNC_OBSERVER_LLM = process.env.ARENA_OBSERVER_LLM_SYNC === 'true';

function clampText(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function getConfiguredMaxRounds(match: ArenaMatchLike): number {
  const configured = asNumber(match.max_rounds, 0);
  const total = asNumber(match.total_rounds, 0);
  return Math.max(configured, total, 1);
}

function getCompletedRounds(match: ArenaMatchLike, rounds: ArenaRoundLike[]): number {
  if (rounds.length > 0) return rounds.length;
  if (match.status === 'settled') {
    const total = asNumber(match.total_rounds, 0);
    const current = asNumber(match.current_round, 0);
    return Math.max(total, current, 1);
  }
  return Math.max(asNumber(match.current_round, 1) - 1, 0);
}

function getBetrayalRounds(match: ArenaMatchLike, rounds: ArenaRoundLike[]): number {
  if (rounds.length > 0) {
    return rounds.filter((round) => round.outcome !== 'CC').length;
  }

  const actions = [match.player_a_action, match.player_b_action];
  return actions.includes('betray') ? 1 : 0;
}

function getLastOutcome(match: ArenaMatchLike, rounds: ArenaRoundLike[]): string | null {
  if (rounds.length > 0) {
    return rounds[rounds.length - 1]?.outcome ?? null;
  }
  if (match.player_a_action && match.player_b_action) {
    return `${match.player_a_action}/${match.player_b_action}`;
  }
  return null;
}

function determineHeadline(
  match: ArenaMatchLike,
  completedRounds: number,
  betrayalRounds: number,
): { zh: string; en: string } {
  if (match.status === 'settled') {
    if (betrayalRounds === 0) {
      return {
        zh: '这场对局以稳定合作收束',
        en: 'This match closed with stable cooperation',
      };
    }

    if (completedRounds > 0 && betrayalRounds === completedRounds) {
      return {
        zh: '这场对局从头到尾都处在冲突压力下',
        en: 'This match stayed under conflict pressure from start to finish',
      };
    }

    return {
      zh: '这场对局在试探与合作之间摇摆',
      en: 'This match swung between testing and cooperation',
    };
  }

  if (match.status === 'negotiating') {
    return {
      zh: '双方仍在谈判阶段试探彼此边界',
      en: 'Both sides are still probing each other during negotiation',
    };
  }

  if (match.status === 'resolving') {
    return {
      zh: '本轮动作已经锁定，系统正在兑现结果',
      en: 'This round is locked and the system is finalizing the result',
    };
  }

  return {
    zh: '双方已经进入落子阶段，结果取决于最后的动作组合',
    en: 'Both sides are in the decision phase and the result now depends on the final move pair',
  };
}

function determineDominantDecisionSource(
  traces: ArenaDecisionTraceRow[],
): 'heuristic' | 'mixed' | 'unknown' {
  if (traces.length === 0) return 'unknown';
  const nonRule = traces.some((trace) => !['heuristic', 'heuristic_fallback'].includes(trace.decision_source));
  return nonRule ? 'mixed' : 'heuristic';
}

function buildTemplate(
  match: ArenaMatchLike,
  rounds: ArenaRoundLike[],
  messages: NegotiationMessageLike[],
  traces: ArenaDecisionTraceRow[],
): SummaryTemplate & { facts: ArenaObserverSummary['facts'] } {
  const completedRounds = getCompletedRounds(match, rounds);
  const configuredMaxRounds = Math.max(getConfiguredMaxRounds(match), completedRounds, 1);
  const betrayalRounds = getBetrayalRounds(match, rounds);
  const negotiationMessages = messages.length;
  const negotiationTraces = traces.filter((trace) => trace.action === 'negotiate').length;
  const lockedDecisionTraces = traces.filter((trace) => trace.action === 'arena_decide').length;
  const llmContentTraces = traces.filter((trace) => trace.content_source === 'llm').length;
  const templateContentTraces = traces.filter((trace) => trace.content_source === 'template').length;
  const dominantDecisionSource = determineDominantDecisionSource(traces);
  const lastOutcome = getLastOutcome(match, rounds);
  const headline = determineHeadline(match, completedRounds, betrayalRounds);

  const summaryZh =
    match.status === 'settled'
      ? `全局共进行了 ${completedRounds}/${configuredMaxRounds} 轮，出现 ${betrayalRounds} 次背叛，留下 ${negotiationMessages} 条谈判消息与 ${traces.length} 条竞技场追踪记录。`
      : `目前已经完成 ${completedRounds}/${configuredMaxRounds} 轮，场内累计 ${negotiationMessages} 条谈判消息与 ${traces.length} 条竞技场追踪记录，系统仍在等待更多动作与结算。`;
  const summaryEn =
    match.status === 'settled'
      ? `The match ran for ${completedRounds}/${configuredMaxRounds} rounds, logged ${betrayalRounds} betrayal rounds, and produced ${negotiationMessages} negotiation messages plus ${traces.length} arena trace entries.`
      : `The match has completed ${completedRounds}/${configuredMaxRounds} rounds so far, with ${negotiationMessages} negotiation messages and ${traces.length} arena trace entries while the system waits for more moves and settlement.`;

  const ruleNoteZh =
    dominantDecisionSource === 'heuristic'
      ? '当前主路径下，动作仍由规则系统决定。'
      : dominantDecisionSource === 'mixed'
        ? '当前记录里同时存在规则与非规则来源，需要继续审计。'
        : '当前还没有足够的竞技场追踪来判定动作来源。';
  const ruleNoteEn =
    dominantDecisionSource === 'heuristic'
      ? 'Under the current main path, the final move still comes from the rule system.'
      : dominantDecisionSource === 'mixed'
        ? 'The current record mixes rule and non-rule sources and should be audited further.'
        : 'There are not enough arena traces yet to classify the action source.';

  const textNoteZh =
    llmContentTraces > 0
      ? `本场有 ${llmContentTraces} 条文本经过 LLM 润色，但它们只影响表达，不影响结算。`
      : '本场暂无 LLM 润色文本痕迹，表达主要来自模板或规则输出。';
  const textNoteEn =
    llmContentTraces > 0
      ? `${llmContentTraces} text entries were polished by the LLM in this match, but they only affect expression and never settlement.`
      : 'This match currently shows no LLM-polished text; expression mainly comes from templates or direct rule output.';

  const focusZh = lastOutcome
    ? `观察重点应放在最近一轮结果 ${lastOutcome}、背叛次数与谈判密度，而不是把文案本身当作因果依据。`
    : '观察重点应放在谈判密度、背叛次数与锁定动作，而不是把文案本身当作因果依据。';
  const focusEn = lastOutcome
    ? `Focus on the latest round result ${lastOutcome}, betrayal count, and negotiation density instead of treating wording itself as the causal source.`
    : 'Focus on negotiation density, betrayal count, and locked moves instead of treating wording itself as the causal source.';

  return {
    headlineZh: headline.zh,
    headlineEn: headline.en,
    summaryZh,
    summaryEn,
    insightZh: `${ruleNoteZh}${textNoteZh}${focusZh}`,
    insightEn: `${ruleNoteEn} ${textNoteEn} ${focusEn}`,
    facts: {
      status: match.status,
      matchType: match.match_type ?? 'prisoners_dilemma',
      completedRounds,
      configuredMaxRounds,
      betrayalRounds,
      negotiationMessages,
      decisionTraces: traces.length,
      negotiationTraces,
      lockedDecisionTraces,
      llmContentTraces,
      templateContentTraces,
      dominantDecisionSource,
      lastOutcome,
    },
  };
}

function parsePolishedSummary(raw: string): SummaryTemplate | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const headlineZh = typeof parsed.headlineZh === 'string' ? clampText(parsed.headlineZh, MAX_HEADLINE) : '';
    const headlineEn = typeof parsed.headlineEn === 'string' ? clampText(parsed.headlineEn, MAX_HEADLINE) : '';
    const summaryZh = typeof parsed.summaryZh === 'string' ? clampText(parsed.summaryZh, MAX_SUMMARY) : '';
    const summaryEn = typeof parsed.summaryEn === 'string' ? clampText(parsed.summaryEn, MAX_SUMMARY) : '';
    const insightZh = typeof parsed.insightZh === 'string' ? clampText(parsed.insightZh, MAX_INSIGHT) : '';
    const insightEn = typeof parsed.insightEn === 'string' ? clampText(parsed.insightEn, MAX_INSIGHT) : '';

    if (!headlineZh || !headlineEn || !summaryZh || !summaryEn || !insightZh || !insightEn) {
      return null;
    }

    return {
      headlineZh,
      headlineEn,
      summaryZh,
      summaryEn,
      insightZh,
      insightEn,
    };
  } catch {
    return null;
  }
}

async function polishTemplate(
  template: SummaryTemplate,
  facts: ArenaObserverSummary['facts'],
): Promise<SummaryTemplate | null> {
  const polished = await llmText({
    scope: 'observer',
    systemPrompt: `You are polishing an observer-facing arena summary for Civilis.

Hard rules:
- Do not change any facts, counts, match status, round counts, betrayal counts, trace counts, or protocol claims.
- Keep the meaning conservative and factual.
- Do not invent motivations, results, or winners.
- Keep each field concise and readable for a dashboard.
- Return strict JSON with exactly these keys:
  headlineZh, headlineEn, summaryZh, summaryEn, insightZh, insightEn`,
    userPrompt: JSON.stringify({
      facts,
      template,
    }),
    maxTokens: 280,
    temperature: 0.2,
    timeoutMs: 5_000,
    retries: 0,
  });

  if (!polished) return null;
  return parsePolishedSummary(polished);
}

export async function buildArenaObserverSummary(
  match: ArenaMatchLike,
  rounds: ArenaRoundLike[],
  messages: NegotiationMessageLike[],
  traces: ArenaDecisionTraceRow[],
): Promise<ArenaObserverSummary> {
  const template = buildTemplate(match, rounds, messages, traces);
  if (!ALLOW_SYNC_OBSERVER_LLM) {
    return {
      source: 'template',
      headline: { zh: template.headlineZh, en: template.headlineEn },
      summary: { zh: template.summaryZh, en: template.summaryEn },
      insight: { zh: template.insightZh, en: template.insightEn },
      facts: template.facts,
    };
  }

  const polished = await polishTemplate(template, template.facts);

  if (polished) {
    return {
      source: 'llm',
      headline: { zh: polished.headlineZh, en: polished.headlineEn },
      summary: { zh: polished.summaryZh, en: polished.summaryEn },
      insight: { zh: polished.insightZh, en: polished.insightEn },
      facts: template.facts,
    };
  }

  return {
    source: 'template',
    headline: { zh: template.headlineZh, en: template.headlineEn },
    summary: { zh: template.summaryZh, en: template.summaryEn },
    insight: { zh: template.insightZh, en: template.insightEn },
    facts: template.facts,
  };
}
