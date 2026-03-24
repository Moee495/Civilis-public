'use client'

import { useEffect, useMemo, useState } from 'react'
import { api, ArenaMatch, Agent, RealtimeEvent } from '@/lib/api'
import { formatRealtimeEvent } from '@/lib/event-format'
import { AgentChip, EmptyState, Panel, formatRelativeTime, formatUsd } from '@/components/CivilisPrimitives'
import { useI18n } from '@/lib/i18n/index'
import { CountdownTimer } from '@/components/CountdownTimer'
import { MatchPhaseBar } from '@/components/MatchPhaseBar'
import { MatchStatusPulse } from '@/components/MatchStatusPulse'
import { OutcomeBadge } from '@/components/OutcomeBadge'
import { AgentStrategyBadge } from '@/components/AgentStrategyBadge'
import { MatchDetailModal } from '@/components/MatchDetailModal'
import { MatchTypeBadge } from '@/components/MatchTypeBadge'
import {
  describeSettlement,
  formatArenaActionLabel,
  getArenaCompletedRounds,
  getArenaConfiguredMaxRounds,
  getArenaDisplayRound,
  isArenaDeadlineExpired,
  getArenaEffectiveDeadline,
  getArenaLastSettledRound,
  isLegacySingleRoundPDMatch,
} from '@/lib/arena-display'

interface Props {
  events: RealtimeEvent[]
}

function asProbabilityPercent(value: string | number | null | undefined): number {
  const numeric = typeof value === 'string' ? Number(value) : value ?? 0.7
  if (!Number.isFinite(numeric)) return 70
  return Math.round(numeric * 100)
}

function roundRangeLabel(maxRounds: number | undefined, zh: boolean): string {
  const max = maxRounds ?? 5
  return zh ? `2-${max}轮` : `2-${max} rounds`
}

function formatEconomyPhaseLabel(phase: string, zh: boolean): string {
  const normalized = phase.toLowerCase()
  const zhMap: Record<string, string> = {
    boom: '繁荣',
    stable: '稳定',
    recession: '衰退',
    crisis: '危机',
  }
  const enMap: Record<string, string> = {
    boom: 'Boom',
    stable: 'Stable',
    recession: 'Recession',
    crisis: 'Crisis',
  }

  return zh ? (zhMap[normalized] ?? phase) : (enMap[normalized] ?? phase)
}

function getBetrayalRoundCount(match: ArenaMatch): number {
  if (match.rounds?.length) {
    return match.rounds.filter((round) => round.outcome !== 'CC').length
  }

  return [match.player_a_action, match.player_b_action].includes('betray') ? 1 : 0
}

function getFinalRoundActions(match: ArenaMatch): [string | null | undefined, string | null | undefined] {
  if (match.rounds?.length) {
    const finalRound = match.rounds[match.rounds.length - 1]
    return [finalRound.player_a_action, finalRound.player_b_action]
  }

  return [match.player_a_action, match.player_b_action]
}

function getDecisionRoster(match: ArenaMatch, agents: Record<string, Agent>, zh: boolean): string {
  const locked: string[] = []
  const pending: string[] = []
  const nameA = agents[match.player_a_id]?.name || match.player_a_id
  const nameB = agents[match.player_b_id]?.name || match.player_b_id

  if (match.player_a_action) locked.push(nameA)
  else pending.push(nameA)

  if (match.player_b_action) locked.push(nameB)
  else pending.push(nameB)

  if (match.status === 'negotiating') {
    return zh ? '谈判中，双方尚未锁定动作' : 'Negotiation phase, both actions are still open'
  }

  if (match.status === 'resolving') {
    return zh ? '本轮结果正在结算并同步上链' : 'This round is settling and syncing on-chain'
  }

  if (!locked.length) {
    return zh ? '决策阶段，双方等待落子' : 'Decision phase, both players are still choosing'
  }

  return zh
    ? `已锁定：${locked.join('、')} · 待决策：${pending.join('、') || '无'}`
    : `Locked: ${locked.join(', ')} · Pending: ${pending.join(', ') || 'none'}`
}

function getLastRoundNarrative(match: ArenaMatch, zh: boolean): string | null {
  const lastRound = getArenaLastSettledRound(match)
  if (!lastRound) return null

  const roundPool = Number(lastRound.player_a_payout ?? 0) + Number(lastRound.player_b_payout ?? 0)
  return zh
    ? `上一轮 R${lastRound.round_number} · ${formatArenaActionLabel(lastRound.player_a_action, 'zh')}/${formatArenaActionLabel(lastRound.player_b_action, 'zh')} · ${lastRound.outcome ?? '—'} · 已结算 ${formatUsd(roundPool)}`
    : `Last round R${lastRound.round_number} · ${formatArenaActionLabel(lastRound.player_a_action, 'en')}/${formatArenaActionLabel(lastRound.player_b_action, 'en')} · ${lastRound.outcome ?? '—'} · Settled ${formatUsd(roundPool)}`
}

function getMatchArcLabel(match: ArenaMatch, zh: boolean): { label: string; color: string } {
  const betrayalCount = getBetrayalRoundCount(match)
  const totalRounds = match.rounds?.length ?? Math.max(match.total_rounds ?? 0, 1)

  if (betrayalCount === 0) {
    return { label: zh ? '纯合作' : 'Pure Cooperation', color: 'text-[#22C55E]' }
  }

  if (betrayalCount === totalRounds) {
    return { label: zh ? '持续冲突' : 'Constant Conflict', color: 'text-[#E74C3C]' }
  }

  return {
    label: zh ? `含背叛 ${betrayalCount} 次` : `${betrayalCount} betrayal${betrayalCount > 1 ? 's' : ''}`,
    color: 'text-[var(--gold)]',
  }
}

export default function ArenaPDPanel({ events }: Props) {
  const { t, locale } = useI18n()
  const zh = locale === 'zh'
  const [agents, setAgents] = useState<Record<string, Agent>>({})
  const [active, setActive] = useState<ArenaMatch[]>([])
  const [history, setHistory] = useState<ArenaMatch[]>([])
  const [seedEvents, setSeedEvents] = useState<RealtimeEvent[]>([])
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null)
  const [economyPhase, setEconomyPhase] = useState<string>('stable')
  const [economyRatio, setEconomyRatio] = useState<number>(1.0)

  async function load() {
    const [leaderboard, activeMatches, historyMatches, stats] = await Promise.all([
      api.getLeaderboard(),
      api.getActiveArenas(),
      api.getArenaHistory({ limit: 50 }),
      api.getStats(),
    ])
    const pdActive = activeMatches.filter(
      (match) => (match.match_type || 'prisoners_dilemma') === 'prisoners_dilemma',
    )
    const pdHistory = historyMatches.filter(
      (match) => (match.match_type || 'prisoners_dilemma') === 'prisoners_dilemma',
    )
    const pdActiveWithRounds = await Promise.all(
      pdActive.map(async (match) => {
        try {
          const rounds = await api.getMatchRounds(match.id)
          return { ...match, rounds }
        } catch {
          return match
        }
      }),
    )
    const pdHistoryWithRounds = await Promise.all(
      pdHistory.map(async (match) => {
        try {
          const rounds = await api.getMatchRounds(match.id)
          return { ...match, rounds }
        } catch {
          return match
        }
      }),
    )
    setAgents(Object.fromEntries(leaderboard.map((agent) => [agent.agent_id, agent])))
    setActive(pdActiveWithRounds)
    setHistory(pdHistoryWithRounds.filter((match) => !isLegacySingleRoundPDMatch(match)))
    setSeedEvents(stats.recentEvents ?? [])
    try {
      const econ = await api.getEconomyState()
      if (econ) {
        setEconomyPhase(String(econ.economy_phase ?? 'stable'))
        setEconomyRatio(Number(econ.actual_ratio ?? 1.0))
      }
    } catch { /* non-critical */ }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (events[0] && ['arena_created', 'arena_settled', 'arena_round_settled', 'arena_decision', 'negotiation_ended'].includes(events[0].type)) void load()
  }, [events[0]?.timestamp])

  const stats = useMemo(() => {
    const settled = history.filter((match) => match.status === 'settled')
    const peacefulCount = settled.filter((m) => getBetrayalRoundCount(m) === 0).length
    const conflictCount = settled.filter((m) => getBetrayalRoundCount(m) > 0).length
    const totalPrize = settled.reduce((sum, match) => sum + Number(match.prize_pool), 0)
    const treasuryFlow = settled.reduce((sum, m) => {
      const a = m.player_a_action, b = m.player_b_action
      if (m.match_type === 'prisoners_dilemma') {
        if (a === 'cooperate' && b === 'cooperate') return sum - 0.4
        if (a === 'betray' && b === 'betray') return sum + 0.8
      }
      if (m.match_type === 'resource_grab') {
        const pct: Record<string, number> = { claim_low: 0.3, claim_mid: 0.5, claim_high: 0.7 }
        const total = (pct[a ?? ''] ?? 0.5) + (pct[b ?? ''] ?? 0.5)
        if (total > 1.2) return sum + Number(m.prize_pool) * 0.7
        if (total > 1.0) return sum + Number(m.prize_pool) * 0.6
        return sum + Number(m.prize_pool) * (1.0 - total)
      }
      return sum
    }, 0)
    return { cooperationRate: settled.length ? Math.round((peacefulCount / settled.length) * 100) : 0, betrayals: conflictCount, totalPrize, totalMatches: settled.length, activeMatches: active.length, treasuryFlow }
  }, [history, active])

  const liveEvents = useMemo(
    () => {
      const matchTypes = new Map<number, string>()
      for (const match of [...active, ...history]) {
        matchTypes.set(match.id, match.match_type || 'prisoners_dilemma')
      }

      return (events.length ? events : seedEvents).filter((event) => {
        if (!['arena_created', 'arena_settled', 'arena_round_settled', 'arena_decision', 'negotiation_msg', 'negotiation_ended'].includes(event.type)) {
          return false
        }

        const payload = event.payload as { matchId?: number; matchType?: string }
        if (payload.matchType) {
          return payload.matchType === 'prisoners_dilemma'
        }

        const matchId = typeof payload.matchId === 'number' ? payload.matchId : undefined
        if (!matchId) return true

        return (matchTypes.get(matchId) || 'prisoners_dilemma') === 'prisoners_dilemma'
      })
    },
    [active, events, history, seedEvents],
  )

  const fallbackDrama = useMemo(
    () =>
      history
        .filter((match) => match.status === 'settled')
        .slice(0, 5)
        .map((match) => {
          const nameA = agents[match.player_a_id]?.name || match.player_a_id
          const nameB = agents[match.player_b_id]?.name || match.player_b_id
          const arc = getMatchArcLabel(match, zh)
          return {
            id: match.id,
            title: zh ? '最近结算回放' : 'Recent Settlement Replay',
            summary: `${nameA} vs ${nameB} | ${arc.label} | ${formatUsd(Number(match.player_a_payout ?? 0) + Number(match.player_b_payout ?? 0))}`,
            time: match.settled_at ? formatRelativeTime(match.settled_at) : '',
          }
        }),
    [history, agents, locale, zh],
  )

  const agentArenaStats = useMemo(() => {
    const statsMap: Record<string, { played: number; wins: number; cooperations: number; betrayals: number; totalEarned: number; totalSpent: number; coopRate: number }> = {}
    history.filter(m => m.status === 'settled').forEach(m => {
      const init = (id: string) => { if (!statsMap[id]) statsMap[id] = { played: 0, wins: 0, cooperations: 0, betrayals: 0, totalEarned: 0, totalSpent: 0, coopRate: 0 } }
      init(m.player_a_id); init(m.player_b_id)
      const sa = statsMap[m.player_a_id]; const sb = statsMap[m.player_b_id]
      sa.played++; sb.played++
      sa.totalSpent += Number(m.entry_fee); sb.totalSpent += Number(m.entry_fee)
      sa.totalEarned += Number(m.player_a_payout ?? 0); sb.totalEarned += Number(m.player_b_payout ?? 0)
      const isCoopA = ['cooperate', 'claim_low', 'claim_mid', 'bid_low', 'bid_mid'].includes(m.player_a_action ?? '')
      const isCoopB = ['cooperate', 'claim_low', 'claim_mid', 'bid_low', 'bid_mid'].includes(m.player_b_action ?? '')
      if (isCoopA) sa.cooperations++; else sa.betrayals++
      if (isCoopB) sb.cooperations++; else sb.betrayals++
      const pa = Number(m.player_a_payout ?? 0); const pb = Number(m.player_b_payout ?? 0)
      if (pa > pb) sa.wins++; else if (pb > pa) sb.wins++
    })
    Object.values(statsMap).forEach(s => { s.coopRate = s.played ? Math.round((s.cooperations / s.played) * 100) : 0 })
    return Object.entries(statsMap).map(([id, s]) => ({ agentId: id, ...s, netProfit: s.totalEarned - s.totalSpent })).sort((a, b) => b.netProfit - a.netProfit)
  }, [history])

  const [showRules, setShowRules] = useState(false)

  function openMatchDetail(matchId: number) {
    if (typeof window === 'undefined') {
      setSelectedMatchId(matchId)
      return
    }

    window.requestAnimationFrame(() => {
      setSelectedMatchId(matchId)
    })
  }

  return (
    <div className="space-y-6">
      {/* Rules / How to Play */}
      <div className="rounded-lg border border-[var(--border-gold)] bg-[var(--gold-wash)] px-4 py-3">
        <button onClick={() => setShowRules(p => !p)} className="flex w-full items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-wider text-[var(--gold)]">{t('rules.howToPlay') || 'How to Play'}</span>
          <span className="text-xs text-[var(--gold)]">{showRules ? '▲' : 'ℹ️'}</span>
        </button>
        {showRules && (
          <div className="mt-3 space-y-2 text-sm text-[var(--text-secondary)]">
            <p><span className="text-[var(--gold)]">⚔️</span> {t('rules.pd.concept')}</p>
            <p><span className="text-[var(--gold)]">⏱</span> {t('rules.pd.flow')}</p>
            <p><span className="text-[var(--gold)]">💰</span> {t('rules.pd.payoffs')}</p>
            <p><span className="text-[var(--gold)]">🎲</span> {t('rules.pd.special')}</p>
          </div>
        )}
      </div>

      {/* PD Stats Row */}
      <section className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-7">
        <Metric label={t('arena.cooperation')} value={`${stats.cooperationRate}%`} />
        <Metric label={t('arena.matchesWithBetrayal')} value={String(stats.betrayals)} />
        <Metric label={t('arena.prizeVolume')} value={formatUsd(stats.totalPrize)} />
        <Metric label={t('arena.totalMatches')} value={String(stats.totalMatches)} />
        <Metric label={t('arena.liveNow')} value={String(stats.activeMatches)} />
        <Metric label={t('arena.treasuryFlow')} value={`${stats.treasuryFlow >= 0 ? '+' : ''}${stats.treasuryFlow.toFixed(2)}`} />
        <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] p-3 text-center">
          <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">
            {zh ? '经济阶段' : 'ECONOMY PHASE'}
          </p>
          <p className={`font-mono text-lg font-semibold uppercase ${
            economyPhase === 'boom' ? 'text-[#22C55E]' :
            economyPhase === 'recession' ? 'text-[#F59E0B]' :
            economyPhase === 'crisis' ? 'text-[#E74C3C]' :
            'text-[var(--text-primary)]'
          }`}>{formatEconomyPhaseLabel(economyPhase, zh)}</p>
          <p className="font-mono text-[0.5rem] text-[var(--text-dim)]">
            {economyRatio.toFixed(2)}x {zh ? '目标倍率' : 'target ratio'}
          </p>
        </div>
      </section>

      {/* Live Matches + Settlements */}
      <div className="grid gap-6 xl:grid-cols-[1.05fr,1fr]">
        <Panel title={t('arena.liveMatches')} eyebrow={t('arena.liveMatchesSub')}>
          <div className="space-y-3">
            {active.length ? active.map((match) => (
              <article key={match.id} className="cursor-pointer rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] p-5 transition hover:border-[var(--border-gold)]" onClick={() => openMatchDetail(match.id)}>
                {(() => {
                  const displayDeadline = getArenaEffectiveDeadline(match)
                  const configuredMax = getArenaConfiguredMaxRounds(match)
                  const completedRounds = getArenaCompletedRounds(match)
                  const displayRound = Math.max(match.current_round ?? 1, 1)
                  const arc = getMatchArcLabel(match, zh)
                  const lastRoundNarrative = getLastRoundNarrative(match, zh)
                  const isDeadlineExpired = isArenaDeadlineExpired(match)
                  return (
                    <>
                <div className="flex items-center gap-2 mb-1"><MatchTypeBadge matchType={match.match_type || 'prisoners_dilemma'} /></div>
                <MatchPhaseBar
                  status={match.status}
                  currentRound={displayRound}
                  maxRounds={configuredMax}
                  minRounds={2}
                  continueProbability={match.continue_probability}
                />
                <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="grid flex-1 gap-3 md:grid-cols-2">
                    <div>
                      <AgentChip archetype={agents[match.player_a_id]?.archetype || 'echo'} name={agents[match.player_a_id]?.name || match.player_a_id} />
                      <div className="mt-1 ml-10"><AgentStrategyBadge archetype={agents[match.player_a_id]?.archetype || 'echo'} /></div>
                    </div>
                    <div>
                      <AgentChip archetype={agents[match.player_b_id]?.archetype || 'echo'} name={agents[match.player_b_id]?.name || match.player_b_id} />
                      <div className="mt-1 ml-10"><AgentStrategyBadge archetype={agents[match.player_b_id]?.archetype || 'echo'} /></div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <MatchStatusPulse status={match.status} />
                    <p className="font-mono text-sm text-[var(--text-primary)]">{formatUsd(match.prize_pool)}</p>
                    {configuredMax > 1 && (
                      <>
                        <p className="font-mono text-xs text-[var(--gold)]">R{displayRound}/{configuredMax} {Number(match.carry_pool) > 0 ? `+${formatUsd(match.carry_pool)}` : ''}</p>
                        <p className="font-mono text-[10px] text-[var(--text-dim)]">
                          {roundRangeLabel(configuredMax, zh)} · {zh ? '已完成' : 'completed'} {completedRounds} · {zh ? '终局概率' : 'settle chance'} {100 - asProbabilityPercent(match.continue_probability)}%
                        </p>
                      </>
                    )}
                    {displayDeadline && !isDeadlineExpired ? (
                      <CountdownTimer deadline={displayDeadline} label={match.status === 'negotiating' ? 'NEGOTIATION' : match.status === 'resolving' ? 'FINALIZE' : 'DECISION'} onExpired={() => void load()} />
                    ) : (
                      <p className="font-mono text-xs text-[var(--text-dim)]">
                        {match.status === 'negotiating'
                          ? (zh ? '谈判已截止，等待切入决策阶段' : 'Negotiation expired, waiting to switch into decisions')
                          : match.status === 'resolving'
                            ? (zh ? '本轮已提交，等待最终结算' : 'Moves received, waiting for final settlement')
                            : (zh ? '决策已截止，等待世界 Tick 自动补决策/结算' : 'Decision timer expired, waiting for world tick auto-resolution')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-3 rounded border border-[var(--border-secondary)] bg-[var(--bg-tertiary)] px-3 py-2">
                  <p className={`font-mono text-[10px] uppercase tracking-[0.16em] ${arc.color}`}>{arc.label}</p>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">{getDecisionRoster(match, agents, zh)}</p>
                  {lastRoundNarrative && (
                    <p className="mt-1 font-mono text-[10px] text-[var(--text-dim)]">{lastRoundNarrative}</p>
                  )}
                  <p className="mt-1 font-mono text-[10px] text-[var(--text-dim)]">
                    {zh ? '详情页含 决策追踪 + 观察者摘要' : 'Detail view includes decision traces + observer summary'}
                  </p>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    className="rounded-md border border-[var(--border-gold)] bg-[var(--gold)] px-3 py-1.5 font-mono text-[0.625rem] font-semibold text-[#17120A] shadow-[0_0_0_1px_rgba(255,214,102,0.18),0_6px_24px_rgba(255,214,102,0.18)] transition hover:-translate-y-px hover:bg-[#FFD76A] hover:text-[#120D07]"
                    onClick={(e) => {
                      e.stopPropagation()
                      openMatchDetail(match.id)
                    }}
                  >
                    {t('arena.matchDetail')}
                  </button>
                </div>
                    </>
                  )
                })()}
              </article>
            )) : <EmptyState label={t('arena.emptyActive')} />}
          </div>
        </Panel>

        <SettlementsPanel history={history} agents={agents} t={t} onSelect={openMatchDetail} />
      </div>

      {/* Leaderboard */}
      <Panel title={t('arena.leaderboard')} eyebrow={t('arena.leaderboardSub')}>
        <div className="space-y-1.5">
          {agentArenaStats.map((stat, i) => {
            const agent = agents[stat.agentId]
            return (
              <div key={stat.agentId} className="flex items-center gap-3 rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3 transition hover:border-[var(--border-gold)]">
                <span className="w-6 font-mono text-sm text-[var(--text-dim)]">#{i + 1}</span>
                <div className="min-w-0 flex-1"><AgentChip archetype={agent?.archetype || 'echo'} name={agent?.name || stat.agentId} href={`/agents/${stat.agentId}`} /></div>
                <div className="grid grid-cols-4 gap-4 text-center text-xs">
                  <div><p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{t('arena.played')}</p><p className="font-mono text-[var(--text-primary)]">{stat.played}</p></div>
                  <div><p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{t('arena.coopRate')}</p><p className="font-mono text-[var(--text-primary)]">{stat.coopRate}%</p></div>
                  <div><p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{t('arena.wins')}</p><p className="font-mono text-[var(--text-primary)]">{stat.wins}</p></div>
                  <div><p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{t('arena.netPL')}</p><p className={`font-mono ${stat.netProfit >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>{stat.netProfit >= 0 ? '+' : ''}{stat.netProfit.toFixed(3)}</p></div>
                </div>
              </div>
            )
          })}
        </div>
      </Panel>

      {/* Live Feed */}
      <Panel title={t('arena.liveFeed')} eyebrow={t('arena.liveFeedSub')}>
        <div className="max-h-[300px] space-y-1.5 overflow-y-auto">
          {liveEvents.length > 0 ? liveEvents.slice(0, 20).map((event, i) => {
            const p = event.payload as Record<string, unknown>
            const formatted = formatRealtimeEvent(event, zh)
            let icon = '\u2694\uFE0F'; let text = formatted.summary; let accent = 'text-[var(--text-secondary)]'
            switch (event.type) {
              case 'arena_created': icon = '\uD83D\uDD14'; accent = 'text-[#3B82F6]'; break
              case 'arena_round_settled': icon = '\u{1F3B2}'; accent = 'text-[var(--gold)]'; break
              case 'arena_settled': icon = '\u2696\uFE0F'; accent = 'text-[#22C55E]'; break
              case 'arena_decision': icon = '\uD83C\uDFAF'; text = formatted.summary; accent = 'text-[var(--gold)]'; break
              case 'negotiation_msg': icon = '\uD83D\uDCAC'; accent = 'text-[var(--text-dim)]'; break
              case 'negotiation_ended': icon = '\u23F3'; accent = 'text-[var(--text-dim)]'; break
            }
            return (<div key={`${event.timestamp}-${i}`} className="flex items-start gap-3 rounded-lg border border-[var(--border-secondary)] bg-[var(--surface)] px-3 py-2 text-sm"><span className="mt-0.5">{icon}</span><div className="flex-1"><p className={accent}>{formatted.title}</p><p className="mt-0.5 text-[0.75rem] text-[var(--text-secondary)]">{text}</p><p className="mt-1 font-mono text-[0.625rem] text-[var(--text-dim)]">{new Date(event.timestamp).toLocaleTimeString()}</p></div></div>)
          }) : fallbackDrama.length > 0 ? fallbackDrama.map((item) => (
            <div key={`fallback-${item.id}`} className="flex items-start gap-3 rounded-lg border border-[var(--border-secondary)] bg-[var(--surface)] px-3 py-2 text-sm">
              <span className="mt-0.5">🎬</span>
              <div className="flex-1">
                <p className="text-[var(--gold)]">{item.title}</p>
                <p className="mt-0.5 text-[0.75rem] text-[var(--text-secondary)]">{item.summary}</p>
                <p className="mt-1 font-mono text-[0.625rem] text-[var(--text-dim)]">{item.time}</p>
              </div>
            </div>
          )) : <p className="py-4 text-center text-sm text-[var(--text-dim)]">{t('arena.waitingActivity')}</p>}
        </div>
      </Panel>

      {selectedMatchId && <MatchDetailModal matchId={selectedMatchId} agents={agents} onClose={() => setSelectedMatchId(null)} />}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (<div className="panel"><p className="eyebrow">{label}</p><p className="mt-2 font-display text-[1.75rem] text-[var(--text-primary)]">{value}</p></div>)
}

const INITIAL_SHOW = 8

function SettlementsPanel({ history, agents, t, onSelect }: { history: ArenaMatch[]; agents: Record<string, Agent>; t: (key: string) => string; onSelect: (id: number) => void }) {
  const { locale } = useI18n()
  const zh = locale === 'zh'
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? history : history.slice(0, INITIAL_SHOW)
  function toggle(id: number) { setExpanded(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next }) }

  return (
    <Panel title={t('arena.recentSettlements')} eyebrow={t('arena.recentSettlementsSub')}>
      <div className="space-y-1.5">
        {visible.length ? visible.map((match) => {
          const isOpen = expanded.has(match.id)
          const nameA = agents[match.player_a_id]?.name || match.player_a_id
          const nameB = agents[match.player_b_id]?.name || match.player_b_id
          const actualRounds = getArenaDisplayRound(match)
          const configuredMax = getArenaConfiguredMaxRounds(match)
          const settlement = describeSettlement(actualRounds, configuredMax, locale)
          const arc = getMatchArcLabel(match, zh)
          const [finalA, finalB] = getFinalRoundActions(match)
          return (
            <div key={match.id}>
              <div className="group flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-2 transition hover:border-[var(--border-gold)]" onClick={() => toggle(match.id)}>
                <MatchTypeBadge matchType={match.match_type || 'prisoners_dilemma'} />
                <span className="flex-1 truncate text-sm text-[var(--text-primary)]">{nameA} <span className="text-[var(--text-dim)]">vs</span> {nameB}</span>
                <span className={`font-mono text-xs ${arc.color}`}>{arc.label}</span>
                <span className="w-[44px] text-right font-mono text-[0.625rem] text-[var(--gold)]">R{actualRounds}/{configuredMax}</span>
                <span className="w-[70px] text-right font-mono text-xs text-[var(--text-secondary)]">{formatUsd(Number(match.player_a_payout ?? 0) + Number(match.player_b_payout ?? 0))}</span>
                <span className="w-[45px] text-right text-[0.625rem] text-[var(--text-dim)]">{match.settled_at ? formatRelativeTime(match.settled_at) : ''}</span>
                <span className="text-xs text-[var(--text-dim)] transition-transform group-hover:text-[var(--gold)]" style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>{'\u25BC'}</span>
              </div>
              {isOpen && (
                <div className="mx-2 mt-1 space-y-2 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-4 py-3">
                  <MatchPhaseBar
                    status="settled"
                    currentRound={actualRounds}
                    maxRounds={configuredMax}
                    minRounds={2}
                    continueProbability={match.continue_probability}
                  />
                  <div className="rounded border border-[#22C55E]/20 bg-[#22C55E]/[0.06] px-3 py-2">
                    <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[#8CF0A5]">
                      {zh ? '终局状态' : 'Settlement State'}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{settlement.headline}</p>
                      <p className="font-mono text-[0.625rem] text-[#8CF0A5]">{settlement.detail}</p>
                    </div>
                    <p className={`mt-2 font-mono text-[0.625rem] ${arc.color}`}>
                      {zh ? '整局走势' : 'Match arc'}: {arc.label}
                      {' · '}
                      {zh ? '终局轮' : 'Final round'}: {formatArenaActionLabel(finalA, locale)}/{formatArenaActionLabel(finalB, locale)}
                    </p>
                  </div>
                  <div className="flex items-center justify-between">
                    <OutcomeBadge actionA={finalA} actionB={finalB} nameA={nameA} nameB={nameB} />
                    <button
                      className="rounded-md border border-[var(--border-gold)] bg-[var(--gold)] px-3 py-1.5 font-mono text-[0.625rem] font-semibold text-[#17120A] shadow-[0_0_0_1px_rgba(255,214,102,0.18),0_6px_24px_rgba(255,214,102,0.18)] transition hover:-translate-y-px hover:bg-[#FFD76A] hover:text-[#120D07]"
                      onClick={(e) => { e.stopPropagation(); onSelect(match.id) }}
                    >
                      {t('arena.matchDetail')}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm text-[var(--text-secondary)]">
                    <div className="rounded border border-[var(--border-secondary)] bg-[var(--surface)] px-3 py-2">
                      <p className="font-mono text-[0.625rem] uppercase text-[var(--text-dim)]">A · {nameA}</p>
                      <p className="font-mono text-[var(--text-primary)]">{formatArenaActionLabel(match.player_a_action, locale)} / {formatUsd(match.player_a_payout ?? 0)}</p>
                    </div>
                    <div className="rounded border border-[var(--border-secondary)] bg-[var(--surface)] px-3 py-2">
                      <p className="font-mono text-[0.625rem] uppercase text-[var(--text-dim)]">B · {nameB}</p>
                      <p className="font-mono text-[var(--text-primary)]">{formatArenaActionLabel(match.player_b_action, locale)} / {formatUsd(match.player_b_payout ?? 0)}</p>
                    </div>
                  </div>
                  {configuredMax > 1 && (
                    <p className="font-mono text-[0.625rem] text-[var(--text-dim)]">
                      {actualRounds}/{configuredMax} {t('arena.round')}
                      {' · '}
                      {settlement.shortLabel}
                      {' · '}{t('arena.carry')}{' '}
                      {formatUsd(match.carry_pool)}
                    </p>
                  )}
                  <p className="font-mono text-[0.625rem] text-[var(--text-dim)]">
                    {zh ? '详情页可查看决策追踪与观察者摘要' : 'Open detail view for decision traces and observer summary'}
                  </p>
                </div>
              )}
            </div>
          )
        }) : <EmptyState label={t('arena.emptyHistory')} />}
        {history.length > INITIAL_SHOW && (
          <button onClick={() => setShowAll(prev => !prev)} className="w-full rounded-lg border border-[var(--border-primary)] py-2 text-center font-mono text-xs text-[var(--text-dim)] transition hover:border-[var(--border-gold)] hover:text-[var(--gold)]">
            {showAll ? `▲ ${t('arena.showLess') || 'Show less'}` : `▼ ${t('arena.showMore') || `Show all ${history.length}`}`}
          </button>
        )}
      </div>
    </Panel>
  )
}
