'use client'

import { useState, useEffect } from 'react'
import { api, ArenaDecisionTrace, ArenaMatch, ArenaMatchDetail, ArenaRound, Agent, NegotiationMessage } from '@/lib/api'
import { AgentChip, formatUsd } from '@/components/CivilisPrimitives'
import { TrustImpact } from '@/components/TrustImpact'
import { PayoffMatrix } from '@/components/PayoffMatrix'
import { MatchPhaseBar } from '@/components/MatchPhaseBar'
import { CountdownTimer } from '@/components/CountdownTimer'
import { useI18n } from '@/lib/i18n/index'
import { formatDynamicNarrative } from '@/lib/dynamic-text'
import {
  actionTextColor,
  describeSettlement,
  formatArenaActionLabel,
  getArenaCompletedRounds,
  getArenaConfiguredMaxRounds,
  getArenaDisplayRound,
  getArenaEffectiveDeadline,
  getArenaLastSettledRound,
  isArenaDeadlineExpired,
} from '@/lib/arena-display'

interface Props {
  matchId: number
  agents: Record<string, Agent>
  onClose: () => void
}

const MSG_TYPE_STYLE: Record<string, { label: string; border: string; bg: string }> = {
  normal: { label: 'MSG', border: 'border-[var(--border-primary)]', bg: 'bg-[var(--surface)]' },
  threat: { label: 'THREAT', border: 'border-[#E74C3C]/30', bg: 'bg-[#E74C3C]/[0.06]' },
  promise: { label: 'PROMISE', border: 'border-[#22C55E]/30', bg: 'bg-[#22C55E]/[0.06]' },
  deception: { label: 'DECEPTION', border: 'border-[var(--gold)]/30', bg: 'bg-[var(--gold)]/[0.06]' },
}

function normalizeReason(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null
  const trimmed = reason.trim()
  return trimmed ? trimmed : null
}

function getLiveDecisionSummary(match: ArenaMatch, agents: Record<string, Agent>, zh: boolean): string {
  const nameA = agents[match.player_a_id]?.name || match.player_a_id
  const nameB = agents[match.player_b_id]?.name || match.player_b_id
  const locked: string[] = []
  const pending: string[] = []

  if (match.player_a_action) locked.push(nameA)
  else pending.push(nameA)
  if (match.player_b_action) locked.push(nameB)
  else pending.push(nameB)

  if (match.status === 'negotiating') {
    return zh ? '当前仍在谈判阶段，尚未进入最终落子。' : 'The match is still in negotiation, so no final moves are locked yet.'
  }

  if (match.status === 'resolving') {
    return zh ? '本轮动作已齐，系统正在结算与同步。' : 'Both moves are in and the round is being settled now.'
  }

  if (!locked.length) {
    return zh ? '当前为决策阶段，双方都还没有锁定动作。' : 'Decision phase is open and both players are still choosing.'
  }

  return zh
    ? `已锁定：${locked.join('、')}；待决策：${pending.join('、') || '无'}。`
    : `Locked: ${locked.join(', ')}; pending: ${pending.join(', ') || 'none'}.`
}

export function MatchDetailModal({ matchId, agents, onClose }: Props) {
  const { t, locale } = useI18n()
  const [match, setMatch] = useState<ArenaMatchDetail | null>(null)
  const [showAllTraces, setShowAllTraces] = useState(false)

  useEffect(() => {
    api.getMatch(matchId).then(setMatch)
  }, [matchId])

  if (!match) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
        <div
          className="rounded-lg border border-[var(--border-primary)] bg-[#111111] px-4 py-3 text-[var(--text-dim)] text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          Loading…
        </div>
      </div>
    )
  }

  const playerA = agents[match.player_a_id]
  const playerB = agents[match.player_b_id]
  const isSettled = match.status === 'settled'
  const zh = locale === 'zh'
  const continuePercent = Math.round((Number(match.continue_probability ?? 0.7) || 0.7) * 100)
  const settlePercent = Math.max(0, 100 - continuePercent)
  const maxRounds = getArenaConfiguredMaxRounds(match)
  const guaranteedRounds = Math.min(2, maxRounds)
  const completedRounds = getArenaCompletedRounds(match)
  const displayRound = getArenaDisplayRound(match)
  const phaseDeadline = getArenaEffectiveDeadline(match)
  const isPhaseDeadlineExpired = isArenaDeadlineExpired(match)
  const lastSettledRound = getArenaLastSettledRound(match)
  const settlement = describeSettlement(displayRound, maxRounds, locale)
  const betrayalRounds = match.rounds?.filter((round) => round.outcome !== 'CC').length ?? 0
  const observerSummary = match.observerSummary
  const visibleTraces = showAllTraces ? match.decisionTraces : match.decisionTraces.slice(0, 4)
  const matchArcSummary = betrayalRounds === 0
    ? (zh ? '整局纯合作' : 'Pure cooperation across the whole match')
    : zh
      ? `整局含 ${betrayalRounds} 次背叛`
      : `${betrayalRounds} betrayal${betrayalRounds > 1 ? 's' : ''} across the whole match`

  const matchType = match.match_type || 'prisoners_dilemma'
  let outcomeLabel = ''
  let outcomeColor = 'text-[var(--text-secondary)]'
  if (isSettled && match.player_a_action && match.player_b_action) {
    const a = match.player_a_action
    const b = match.player_b_action
    if (matchType === 'prisoners_dilemma') {
      if (a === 'cooperate' && b === 'cooperate') { outcomeLabel = t('arena.mutualTrust'); outcomeColor = 'text-[#22C55E]' }
      else if (a === 'betray' && b === 'betray') { outcomeLabel = t('arena.mutualLoss'); outcomeColor = 'text-[var(--text-dim)]' }
      else if (a === 'cooperate' && b === 'betray') { outcomeLabel = zh ? `被 ${playerB?.name || 'B'} 背叛` : `Betrayed by ${playerB?.name || 'B'}`; outcomeColor = 'text-[#E74C3C]' }
      else if (a === 'betray' && b === 'cooperate') { outcomeLabel = zh ? `被 ${playerA?.name || 'A'} 背叛` : `Betrayed by ${playerA?.name || 'A'}`; outcomeColor = 'text-[#E74C3C]' }
    } else if (matchType === 'resource_grab') {
      const pctA = a === 'claim_low' ? 0.3 : a === 'claim_mid' ? 0.5 : 0.7
      const pctB = b === 'claim_low' ? 0.3 : b === 'claim_mid' ? 0.5 : 0.7
      if (pctA + pctB <= 1.0) { outcomeLabel = `${t('arena.resourceGrab')} — ${((pctA + pctB) * 100).toFixed(0)}%`; outcomeColor = 'text-[#22C55E]' }
      else if (pctA + pctB <= 1.2) { outcomeLabel = `${t('arena.conflict')} — ${t('arena.overClaimed')}`; outcomeColor = 'text-[var(--gold)]' }
      else { outcomeLabel = `${t('arena.conflict')} — ${((pctA + pctB) * 100).toFixed(0)}%`; outcomeColor = 'text-[#E74C3C]' }
    } else if (matchType === 'info_auction') {
      if (a === b) { outcomeLabel = `${t('arena.infoAuction')} — Tie`; outcomeColor = 'text-[var(--text-secondary)]' }
      else {
        const winner = Number(match.player_a_payout ?? 0) > Number(match.player_b_payout ?? 0) ? (playerA?.name || 'A') : (playerB?.name || 'B')
        outcomeLabel = `${t('arena.auctionWinner')}: ${winner}`; outcomeColor = 'text-[#A855F7]'
      }
    }
  }

  function formatTraceAction(trace: ArenaDecisionTrace): string {
    const metadata = trace.metadata ?? {}
    if (trace.action === 'arena_decide') {
      const arenaAction = typeof metadata.arenaAction === 'string' ? metadata.arenaAction : null
      return arenaAction ? formatArenaActionLabel(arenaAction, locale) : (zh ? '锁定动作' : 'Locked move')
    }
    if (trace.action === 'negotiate') {
      const messageType = typeof metadata.messageType === 'string' ? metadata.messageType : 'normal'
      const zhMap: Record<string, string> = {
        normal: '谈判表达',
        threat: '威胁谈判',
        promise: '承诺谈判',
        deception: '欺骗谈判',
      }
      const enMap: Record<string, string> = {
        normal: 'Negotiation',
        threat: 'Threat',
        promise: 'Promise',
        deception: 'Deception',
      }
      return zh ? (zhMap[messageType] ?? '谈判表达') : (enMap[messageType] ?? 'Negotiation')
    }

    return trace.action
  }

  function formatTraceDecisionSource(trace: ArenaDecisionTrace): string {
    if (trace.decision_source === 'heuristic_fallback') {
      return zh ? '规则兜底' : 'Rule Fallback'
    }
    if (trace.decision_source === 'heuristic') {
      return zh ? '规则决定' : 'Rule'
    }
    return zh ? '混合来源' : 'Mixed'
  }

  function formatTraceContentSource(trace: ArenaDecisionTrace): string {
    if (trace.content_source === 'llm') return zh ? 'LLM 润色' : 'LLM Polish'
    if (trace.content_source === 'template') return zh ? '模板文本' : 'Template Text'
    return zh ? '无额外文本' : 'No Extra Text'
  }

  function formatTraceRound(trace: ArenaDecisionTrace): string | null {
    const metadata = trace.metadata ?? {}
    const rawRound = typeof metadata.arenaRound === 'number'
      ? metadata.arenaRound
      : typeof metadata.arenaRound === 'string'
        ? Number(metadata.arenaRound)
        : null
    if (!rawRound || !Number.isFinite(rawRound) || rawRound <= 0) return null
    return `R${rawRound}`
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-[2px] p-4" onClick={onClose}>
      <div
        className="w-full max-w-4xl max-h-[88vh] overflow-y-auto rounded-xl border border-[var(--border-gold)]/25 bg-[#111111] p-6 space-y-6 shadow-[0_30px_120px_rgba(0,0,0,0.65)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 -mx-6 -mt-6 flex items-center justify-between border-b border-[var(--border-primary)] bg-[#111111]/95 px-6 py-4 backdrop-blur">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-[var(--text-dim)]">{t('arena.matchDetail')} #{match.id}</p>
            <p className="text-lg font-semibold text-[var(--text-primary)] mt-1">
              {playerA?.name || match.player_a_id} vs {playerB?.name || match.player_b_id}
            </p>
          </div>
          <button onClick={onClose} className="rounded border border-[var(--border-primary)] px-2.5 py-1 text-[var(--text-dim)] transition hover:border-[var(--border-gold)] hover:text-[var(--gold)]">&times;</button>
        </div>

        {/* Status + Prize + Rounds */}
        <div className="grid grid-cols-4 gap-3">
          <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '状态' : 'Status'}</p>
            <p className={`mt-1 font-mono text-sm ${match.status === 'settled' ? 'text-[#22C55E]' : match.status === 'resolving' ? 'text-[#F59E0B]' : match.status === 'deciding' ? 'text-[var(--gold)]' : 'text-[#3B82F6]'}`}>
              {match.status === 'resolving' ? 'RESOLVING' : match.status.toUpperCase()}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-dim)]">{t('arena.prizeVolume')}</p>
            <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">{formatUsd(match.prize_pool)}</p>
          </div>
          <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '入场费' : 'Entry'}</p>
            <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">{formatUsd(match.entry_fee)}</p>
          </div>
          <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3 text-center">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-dim)]">{t('arena.round')}</p>
            <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">
              {isSettled ? `${displayRound}/${maxRounds}` : `${displayRound}/${maxRounds}`}
            </p>
            {isSettled ? (
              <p className="text-[10px] mt-0.5 text-[#8CF0A5]">{settlement.shortLabel}</p>
            ) : match.max_rounds > 1 && (
              <p className="text-[10px] text-[var(--gold)]/60 mt-0.5">
                {zh ? `已完成 ${completedRounds} 轮，当前进行到 R${displayRound}` : `${completedRounds} rounds completed, now in R${displayRound}`}
              </p>
            )}
          </div>
        </div>

        {observerSummary && (
          <div className="rounded-lg border border-[var(--border-gold)]/25 bg-[var(--gold)]/[0.06] px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-[var(--gold)]">
                  {zh ? '观察者摘要' : 'Observer Summary'}
                </p>
                <p className="mt-1 text-base font-semibold text-[var(--text-primary)]">
                  {zh ? observerSummary.headline.zh : observerSummary.headline.en}
                </p>
              </div>
              <div className="rounded-full border border-[var(--border-gold)]/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--gold)]">
                {observerSummary.source === 'llm'
                  ? (zh ? 'LLM 润色' : 'LLM Polished')
                  : (zh ? '模板优先' : 'Template First')}
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
              {zh ? observerSummary.summary.zh : observerSummary.summary.en}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded border border-[var(--border-primary)] bg-[#121212] px-3 py-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-dim)]">
                  {zh ? '轮次进度' : 'Round Progress'}
                </p>
                <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">
                  {observerSummary.facts.completedRounds}/{observerSummary.facts.configuredMaxRounds}
                </p>
              </div>
              <div className="rounded border border-[var(--border-primary)] bg-[#121212] px-3 py-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-dim)]">
                  {zh ? '背叛轮次' : 'Betrayal Rounds'}
                </p>
                <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">
                  {observerSummary.facts.betrayalRounds}
                </p>
              </div>
              <div className="rounded border border-[var(--border-primary)] bg-[#121212] px-3 py-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-dim)]">
                  {zh ? '谈判消息' : 'Negotiations'}
                </p>
                <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">
                  {observerSummary.facts.negotiationMessages}
                </p>
              </div>
              <div className="rounded border border-[var(--border-primary)] bg-[#121212] px-3 py-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-dim)]">
                  {zh ? '决策追踪' : 'Decision Traces'}
                </p>
                <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">
                  {observerSummary.facts.decisionTraces}
                </p>
              </div>
              <div className="rounded border border-[var(--border-primary)] bg-[#121212] px-3 py-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-dim)]">
                  {zh ? 'LLM 文本' : 'LLM Text'}
                </p>
                <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">
                  {observerSummary.facts.llmContentTraces}
                </p>
              </div>
            </div>
            <div className="mt-3 rounded border border-[var(--border-primary)]/70 bg-[#111111] px-3 py-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-dim)]">
                {zh ? '观察提示' : 'Observer Note'}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">
                {zh ? observerSummary.insight.zh : observerSummary.insight.en}
              </p>
            </div>
          </div>
        )}

        {!isSettled && (
          <div className="rounded-lg border border-[var(--gold)]/20 bg-[var(--gold)]/[0.06] px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-[var(--gold)]">{zh ? '当前进度' : 'Live State'}</p>
                <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">
                  {zh ? `当前进行到 R${displayRound}/${maxRounds}` : `Now playing R${displayRound}/${maxRounds}`}
                </p>
              </div>
              {phaseDeadline && !isPhaseDeadlineExpired ? (
                <CountdownTimer
                  deadline={phaseDeadline}
                  label={match.status === 'negotiating' ? 'NEGOTIATION' : match.status === 'resolving' ? 'FINALIZE' : 'DECISION'}
                />
              ) : (
                <p className="font-mono text-[11px] text-[var(--text-dim)]">
                  {match.status === 'negotiating'
                    ? (zh ? '谈判时限已过，等待进入决策阶段' : 'Negotiation expired, waiting to enter decision phase')
                    : match.status === 'resolving'
                      ? (zh ? '系统正在处理本轮结算' : 'The system is finalizing this round')
                      : (zh ? '决策时限已过，等待世界 Tick 自动结算' : 'Decision expired, waiting for world tick auto-resolution')}
                </p>
              )}
            </div>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{getLiveDecisionSummary(match, agents, zh)}</p>
            {lastSettledRound && (
              <p className="mt-2 font-mono text-[11px] text-[var(--text-dim)]">
                {zh
                  ? `上一轮 R${lastSettledRound.round_number}：${formatArenaActionLabel(lastSettledRound.player_a_action, locale)}/${formatArenaActionLabel(lastSettledRound.player_b_action, locale)} · ${lastSettledRound.outcome ?? '—'}`
                  : `Last round R${lastSettledRound.round_number}: ${formatArenaActionLabel(lastSettledRound.player_a_action, locale)}/${formatArenaActionLabel(lastSettledRound.player_b_action, locale)} · ${lastSettledRound.outcome ?? '—'}`}
              </p>
            )}
          </div>
        )}

        {isSettled && (
          <div className="rounded-lg border border-[#22C55E]/25 bg-[#22C55E]/[0.08] px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-[#8CF0A5]">{zh ? '终局摘要' : 'Settlement Summary'}</p>
                <p className="mt-1 text-sm font-semibold text-[var(--text-primary)]">{settlement.headline}</p>
              </div>
              <p className="font-mono text-xs text-[#8CF0A5]">{settlement.detail}</p>
            </div>
            <p className={`mt-2 font-mono text-[0.625rem] ${betrayalRounds > 0 ? 'text-[var(--gold)]' : 'text-[#8CF0A5]'}`}>
              {matchArcSummary}
            </p>
          </div>
        )}

        {maxRounds > 1 && (
          <div className="rounded-lg border border-[var(--border-primary)] bg-[#151515] p-4">
            <MatchPhaseBar
              status={match.status}
              currentRound={displayRound}
              maxRounds={maxRounds}
              minRounds={2}
              continueProbability={match.continue_probability}
            />
          </div>
        )}

        <div className="rounded-lg border border-[var(--border-primary)] bg-[#151515] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-dim)]">
                {zh ? '决策追踪' : 'Decision Trace'}
              </p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {zh
                  ? '这里只展示事实型追踪：谁在何时锁定了动作、文本来自规则模板还是 LLM 润色，但不会改写任何结算。'
                  : 'This panel shows factual traces only: who locked which move and whether wording came from a rule template or LLM polish. It never rewrites settlement.'}
              </p>
            </div>
            {match.decisionTraces.length > 4 && (
              <button
                onClick={() => setShowAllTraces((value) => !value)}
                className="rounded-lg border border-[var(--border-primary)] px-3 py-1.5 font-mono text-[11px] text-[var(--text-dim)] transition hover:border-[var(--border-gold)] hover:text-[var(--gold)]"
              >
                {showAllTraces
                  ? (zh ? '▲ 收起追踪' : '▲ Collapse Traces')
                  : (zh ? `▼ 查看全部 ${match.decisionTraces.length} 条` : `▼ Show all ${match.decisionTraces.length}`)}
              </button>
            )}
          </div>
          {match.decisionTraces.length > 0 ? (
            <div className="mt-3 space-y-2">
              {visibleTraces.map((trace) => {
                const traceRound = formatTraceRound(trace)
                const traceActor = agents[trace.agent_id]?.name || trace.agent_name || trace.agent_id
                const traceContent = trace.final_content || trace.template_content
                return (
                  <div key={trace.id} className="rounded-lg border border-[var(--border-secondary)] bg-[#111111] px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-[var(--text-primary)]">{traceActor}</span>
                      {traceRound && (
                        <span className="rounded border border-[var(--border-primary)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-dim)]">
                          {traceRound}
                        </span>
                      )}
                      <span className="rounded border border-[var(--border-gold)]/30 bg-[var(--gold)]/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--gold)]">
                        {formatTraceAction(trace)}
                      </span>
                      <span className="rounded border border-[#3B82F6]/25 bg-[#3B82F6]/[0.08] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[#93C5FD]">
                        {formatTraceDecisionSource(trace)}
                      </span>
                      <span className="rounded border border-[var(--border-primary)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-dim)]">
                        {formatTraceContentSource(trace)}
                      </span>
                    </div>
                    {trace.reason_summary && (
                      <p className="mt-2 text-sm text-[var(--text-secondary)]">
                        {formatDynamicNarrative(trace.reason_summary, locale === 'zh')}
                      </p>
                    )}
                    {traceContent && (
                      <div className="mt-2 rounded border border-[var(--border-primary)]/70 bg-[#0d0d0d] px-3 py-2">
                        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-dim)]">
                          {trace.content_source === 'llm'
                            ? (zh ? '最终表达' : 'Final Wording')
                            : (zh ? '规则草稿' : 'Rule Draft')}
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">
                          {formatDynamicNarrative(traceContent, locale === 'zh')}
                        </p>
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[var(--text-dim)]">
                      <span>{new Date(trace.created_at).toLocaleString()}</span>
                      {trace.llm_model && <span>{trace.llm_model}</span>}
                      {trace.latency_ms != null && <span>{trace.latency_ms}ms</span>}
                      {trace.fallback_used && <span>{zh ? '使用回退' : 'fallback used'}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="mt-3 text-sm text-[var(--text-dim)]">
              {zh ? '这场对局暂时还没有落下可展示的竞技场追踪。' : 'No arena decision traces are available for this match yet.'}
            </p>
          )}
        </div>

        {match.rounds && match.rounds.length > 0 && (
          <div className="rounded-lg border border-[var(--border-primary)] bg-[#151515] p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-dim)] mb-3">
              {zh ? '已完成轮次摘要' : 'Completed Round Summary'}
            </p>
            <div className="flex flex-wrap gap-2">
              {match.rounds.map((round) => (
                <div key={`summary-${round.id}`} className="min-w-[132px] rounded border border-[var(--border-secondary)] bg-[#101010] px-3 py-2.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)]">
                  <p className="font-mono text-[11px] text-[var(--text-dim)]">R{round.round_number} · {round.outcome}</p>
                  <p className="mt-1 font-mono text-xs text-[var(--text-primary)]">
                    <span className={actionTextColor(round.player_a_action)}>{formatArenaActionLabel(round.player_a_action, locale)}</span>
                    <span className="text-[var(--text-dim)]"> / </span>
                    <span className={actionTextColor(round.player_b_action)}>{formatArenaActionLabel(round.player_b_action, locale)}</span>
                  </p>
                  {(normalizeReason(round.player_a_reason) || normalizeReason(round.player_b_reason)) && (
                    <div className="mt-2 space-y-1 font-mono text-[10px] text-[var(--text-secondary)]">
                      {normalizeReason(round.player_a_reason) && (
                          <p>{playerA?.name || 'A'}: {formatDynamicNarrative(normalizeReason(round.player_a_reason), locale === 'zh')}</p>
                      )}
                      {normalizeReason(round.player_b_reason) && (
                          <p>{playerB?.name || 'B'}: {formatDynamicNarrative(normalizeReason(round.player_b_reason), locale === 'zh')}</p>
                      )}
                    </div>
                  )}
                  <p className="mt-1 font-mono text-[11px] text-[var(--gold)]">
                    {formatUsd(Number(round.player_a_payout) + Number(round.player_b_payout))}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Snowball Round Timeline */}
        {match.rounds && match.rounds.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-dim)] mb-3">{t('arena.roundHistory')}</p>
            <div className="space-y-2">
              {match.rounds.map((round: ArenaRound, idx: number) => {
                const outcomeEmoji = matchType === 'prisoners_dilemma'
                  ? (round.outcome === 'CC' ? '\u{1F91D}' : round.outcome === 'DD' ? '\u{1F480}' : '\u{1F5E1}\uFE0F')
                  : matchType === 'resource_grab' ? '\u{1F48E}' : '\u{1F50D}'
                const isFinalRound = isSettled && idx === match.rounds!.length - 1
                return (
                  <div key={round.id} className={`rounded-lg border px-4 py-3 ${isFinalRound ? 'border-[var(--border-gold)] bg-[var(--gold)]/[0.08] shadow-[0_0_0_1px_rgba(255,215,0,0.08)]' : 'border-[var(--border-primary)] bg-[#131313]'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-[var(--text-primary)]">
                        {outcomeEmoji} R{round.round_number} {isFinalRound ? (zh ? '· 终局轮' : '· FINAL ROUND') : ''}
                      </span>
                      <span className="font-mono text-xs text-[var(--text-dim)]">{round.outcome}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-[var(--text-primary)]">
                      <span>{playerA?.name || 'A'}: <span className={actionTextColor(round.player_a_action)}>{formatArenaActionLabel(round.player_a_action, locale)}</span></span>
                      <span>{playerB?.name || 'B'}: <span className={actionTextColor(round.player_b_action)}>{formatArenaActionLabel(round.player_b_action, locale)}</span></span>
                    </div>
                    {(normalizeReason(round.player_a_reason) || normalizeReason(round.player_b_reason)) && (
                      <div className="mt-2 rounded border border-[var(--border-primary)]/60 bg-[#0f0f0f] px-3 py-2 text-[11px] text-[var(--text-secondary)]">
                        {normalizeReason(round.player_a_reason) && (
                          <p><span className="text-[var(--gold)]">{playerA?.name || 'A'}:</span> {formatDynamicNarrative(normalizeReason(round.player_a_reason), locale === 'zh')}</p>
                        )}
                        {normalizeReason(round.player_b_reason) && (
                          <p className="mt-1"><span className="text-[var(--gold)]">{playerB?.name || 'B'}:</span> {formatDynamicNarrative(normalizeReason(round.player_b_reason), locale === 'zh')}</p>
                        )}
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-1 text-xs">
                      <span className="text-[var(--text-secondary)]">{t('arena.roundPool')}: {formatUsd(round.round_pool)}</span>
                      <span className="text-[var(--text-secondary)]">{t('arena.settled')}: {formatUsd(round.settle_amount)}</span>
                      {!isFinalRound && <span className="text-[var(--gold)]">{t('arena.carry')}: {formatUsd(round.carry_amount)}</span>}
                    </div>
                    <div className="flex items-center justify-between mt-1 font-mono text-xs">
                      <span className="text-[var(--text-primary)]">{formatUsd(round.player_a_payout)}</span>
                      <span className="text-[var(--text-primary)]">{formatUsd(round.player_b_payout)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Player Actions (visible only after settlement) */}
        {isSettled && (
          <div className="space-y-3">
            <p className={`text-center font-semibold text-sm ${outcomeColor}`}>{outcomeLabel}</p>
            <div className="grid grid-cols-2 gap-3">
              <div className={`rounded-lg border p-4 text-center ${actionStyle(match.player_a_action)}`}>
                <AgentChip archetype={playerA?.archetype || 'echo'} name={playerA?.name || match.player_a_id} />
                <p className={`mt-3 font-mono text-lg font-bold ${actionTextColor(match.player_a_action)}`}>
                  {formatArenaActionLabel(match.player_a_action || '???', locale)}
                </p>
                <p className="mt-1 font-mono text-base text-[var(--text-primary)]">{formatUsd(match.player_a_payout ?? 0)}</p>
                {normalizeReason(match.player_a_reason) && (
                  <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{formatDynamicNarrative(match.player_a_reason, locale === 'zh')}</p>
                )}
              </div>
              <div className={`rounded-lg border p-4 text-center ${actionStyle(match.player_b_action)}`}>
                <AgentChip archetype={playerB?.archetype || 'echo'} name={playerB?.name || match.player_b_id} />
                <p className={`mt-3 font-mono text-lg font-bold ${actionTextColor(match.player_b_action)}`}>
                  {formatArenaActionLabel(match.player_b_action || '???', locale)}
                </p>
                <p className="mt-1 font-mono text-base text-[var(--text-primary)]">{formatUsd(match.player_b_payout ?? 0)}</p>
                {normalizeReason(match.player_b_reason) && (
                  <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{formatDynamicNarrative(match.player_b_reason, locale === 'zh')}</p>
                )}
              </div>
            </div>
            <TrustImpact
              actionA={match.player_a_action}
              actionB={match.player_b_action}
              nameA={playerA?.name || 'A'}
              nameB={playerB?.name || 'B'}
            />
          </div>
        )}

        {/* Negotiation Transcript */}
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-dim)] mb-3">{t('arena.negotiationTranscript')}</p>
          {match.negotiationMessages && match.negotiationMessages.length > 0 ? (
            <div className="space-y-2">
              {match.negotiationMessages.map((msg: NegotiationMessage) => {
                const style = MSG_TYPE_STYLE[msg.message_type] || MSG_TYPE_STYLE.normal
                const senderName = agents[msg.sender_agent_id]?.name || msg.sender_agent_id
                const isPlayerA = msg.sender_agent_id === match.player_a_id
                return (
                  <div key={msg.id} className={`rounded-lg border ${style.border} ${style.bg} px-4 py-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)] ${isPlayerA ? '' : 'ml-8'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-[var(--text-secondary)]">{senderName}</span>
                      <span className={`text-[10px] uppercase tracking-[0.15em] px-1.5 py-0.5 rounded border ${style.border}`}>
                        {style.label}
                      </span>
                    </div>
                    <p className="text-sm text-[var(--text-secondary)]">{formatDynamicNarrative(msg.content, locale === 'zh')}</p>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm text-[var(--text-dim)] text-center py-4">
              {isSettled ? t('arena.noMessages') : t('arena.messagesPrivate')}
            </p>
          )}
        </div>

        {/* Payoff Matrix */}
        {isSettled && (
          <PayoffMatrix
            matchType={matchType}
            actionA={match.player_a_action}
            actionB={match.player_b_action}
            nameA={playerA?.name || 'A'}
            nameB={playerB?.name || 'B'}
          />
        )}
      </div>
    </div>
  )
}

function actionStyle(action?: string | null): string {
  if (!action) return 'border-[var(--border-primary)] bg-[var(--surface)]'
  if (action === 'cooperate') return 'border-[#22C55E]/20 bg-[#22C55E]/[0.04]'
  if (action === 'betray') return 'border-[#E74C3C]/20 bg-[#E74C3C]/[0.04]'
  if (action.startsWith('claim_low')) return 'border-[#22C55E]/20 bg-[#22C55E]/[0.04]'
  if (action.startsWith('claim_mid')) return 'border-[#3B82F6]/20 bg-[#3B82F6]/[0.04]'
  if (action.startsWith('claim_high')) return 'border-[var(--gold)]/20 bg-[var(--gold)]/[0.04]'
  if (action.startsWith('bid_low')) return 'border-[var(--border-primary)] bg-[var(--surface)]'
  if (action.startsWith('bid_mid')) return 'border-[#A855F7]/20 bg-[#A855F7]/[0.04]'
  if (action.startsWith('bid_high')) return 'border-[#A855F7]/30 bg-[#A855F7]/[0.06]'
  return 'border-[var(--border-primary)] bg-[var(--surface)]'
}
