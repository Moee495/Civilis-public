'use client'

import { useEffect, useState } from 'react'
import { api, CommonsRound, CommonsDecision, RealtimeEvent } from '@/lib/api'
import { AgentChip, EmptyState, Panel, formatRelativeTime, formatUsd, archetypeMeta } from '@/components/CivilisPrimitives'
import { useI18n } from '@/lib/i18n/index'

interface Props {
  events: RealtimeEvent[]
}

const DECISION_META: Record<string, { bg: string; text: string; border: string; label: string; labelZh: string; icon: string; cost: string }> = {
  contribute: { bg: 'bg-[#22C55E]/15', text: 'text-[#22C55E]', border: 'border-[#22C55E]/30', label: 'Contribute', labelZh: '贡献', icon: '🤝', cost: '0.5' },
  free_ride:  { bg: 'bg-[#6B7280]/15', text: 'text-[#9CA3AF]', border: 'border-[#6B7280]/30', label: 'Free Ride', labelZh: '搭便车', icon: '🏄', cost: '0' },
  hoard:      { bg: 'bg-[#F59E0B]/15', text: 'text-[#F59E0B]', border: 'border-[#F59E0B]/30', label: 'Hoard', labelZh: '囤积', icon: '🏦', cost: '0' },
  sabotage:   { bg: 'bg-[#E74C3C]/15', text: 'text-[#E74C3C]', border: 'border-[#E74C3C]/30', label: 'Sabotage', labelZh: '破坏', icon: '💣', cost: '0.3' },
}
const COMMONS_RULES = {
  contributeWeight: 1.0,
  freeRideWeight: 0.72,
  hoardSafety: 0.15,
  sabotageLootRate: 0.18,
  sabotageDamagePerPlayer: 0.2,
  sabotageDetectBase: 0.2,
  sabotageDetectPerPlayer: 0.15,
  sabotageDetectCoopFactor: 0.2,
} as const

function humanizeReasonToken(token: string, locale: string): string {
  const zh = locale === 'zh'
  const [key, value] = token.split(':')
  if (!value) {
    const flat: Record<string, [string, string]> = {
      contribute: ['贡献', 'Contribute'],
      free_ride: ['搭便车', 'Free Ride'],
      hoard: ['囤积', 'Hoard'],
      sabotage: ['破坏', 'Sabotage'],
      intel: ['情报影响', 'Intel'],
      pd_memory: ['PD记忆', 'PD memory'],
      survival_floor: ['生存底线', 'Survival floor'],
    }
    const pair = flat[token]
    return pair ? (zh ? pair[0] : pair[1]) : token.replace(/_/g, ' ')
  }

  if (key === 'wealth') {
    const map: Record<string, [string, string]> = {
      rising: ['财富上升', 'wealth rising'],
      stable: ['财富稳定', 'wealth stable'],
      falling: ['财富下滑', 'wealth falling'],
      crisis: ['财富危机', 'wealth crisis'],
    }
    return zh ? (map[value]?.[0] ?? `财富:${value}`) : (map[value]?.[1] ?? `wealth:${value}`)
  }

  if (key === 'mood') {
    const map: Record<string, [string, string]> = {
      euphoric: ['狂喜', 'euphoric'],
      confident: ['自信', 'confident'],
      calm: ['平静', 'calm'],
      anxious: ['焦虑', 'anxious'],
      fearful: ['恐惧', 'fearful'],
      desperate: ['绝望', 'desperate'],
    }
    return zh ? (map[value]?.[0] ?? `情绪:${value}`) : (map[value]?.[1] ?? `mood:${value}`)
  }

  if (key === 'eco') {
    const map: Record<string, [string, string]> = {
      boom: ['繁荣期', 'boom'],
      stable: ['稳定期', 'stable'],
      recession: ['衰退期', 'recession'],
      crisis: ['危机期', 'crisis'],
    }
    return zh ? (map[value]?.[0] ?? `经济:${value}`) : (map[value]?.[1] ?? `eco:${value}`)
  }

  if (key === 'balance<1.0') {
    return zh ? '余额低于 1.0' : 'balance below 1.0'
  }

  return `${key}:${value}`
}

function formatCommonsReason(reason: string | undefined, locale: string): string[] {
  if (!reason) return []
  return reason
    .split('|')
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((token) => humanizeReasonToken(token, locale))
}

function topScoreEntries(scoreSnapshot: Record<string, number> | null | undefined): Array<{ key: string; value: number }> {
  if (!scoreSnapshot || typeof scoreSnapshot !== 'object') return []
  return Object.entries(scoreSnapshot)
    .map(([key, value]) => ({ key, value: Number(value) }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, 2)
}

function formatDecisionScoreLabel(key: string, locale: string): string {
  const meta = DECISION_META[key]
  if (meta) return locale === 'zh' ? meta.labelZh : meta.label
  return key.replace(/_/g, ' ')
}

function coopColor(rate: number): string {
  if (rate >= 0.6) return 'text-[#22C55E]'
  if (rate >= 0.4) return 'text-[#F59E0B]'
  return 'text-[#E74C3C]'
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/* Stat Card — matches PD panel's Metric style */
function Metric({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-[#22C55E]/20 bg-[var(--surface)] p-4">
      <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[#22C55E]/60">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-bold ${color || 'text-[var(--text-primary)]'}`}>{value}</p>
      {sub && <p className="mt-0.5 font-mono text-[0.5rem] text-[var(--text-dim)]">{sub}</p>}
    </div>
  )
}

/* SVG Donut Chart — 4 segments */
function DonutChart({ counts, total, centerText }: { counts: { contribute: number; free_ride: number; hoard: number; sabotage: number }; total: number; centerText: string }) {
  if (total === 0) return null
  const colors = { contribute: '#22C55E', free_ride: '#6B7280', hoard: '#F59E0B', sabotage: '#E74C3C' }
  const radius = 42
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const segments = (['contribute', 'free_ride', 'hoard', 'sabotage'] as const).map(key => {
    const pct = (counts[key] / total) * 100
    const dash = (pct / 100) * circumference
    const seg = { key, pct, dash, offset, color: colors[key] }
    offset += dash
    return seg
  }).filter(s => s.pct > 0)

  return (
    <div className="relative flex items-center justify-center">
      <svg width="140" height="140" viewBox="0 0 100 100">
        {segments.map(s => (
          <circle key={s.key} cx="50" cy="50" r={radius} fill="none" stroke={s.color} strokeWidth="12"
            strokeDasharray={`${s.dash} ${circumference - s.dash}`}
            strokeDashoffset={-s.offset} strokeLinecap="butt"
            style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }} />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-2xl font-bold text-[#22C55E]">{centerText}</span>
        <span className="font-mono text-[0.5rem] text-[var(--text-dim)]">COOP</span>
      </div>
    </div>
  )
}

/* Round Progress Bar */
function RoundProgress({ countdown, total }: { countdown: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(100, ((total - countdown) / total) * 100)) : 0
  return (
    <div className="w-full">
      <div className="flex items-center justify-between text-[0.625rem] font-mono">
        <span className="text-[#22C55E]/70">ROUND PROGRESS</span>
        <span className="text-[#22C55E] font-bold">{formatCountdown(countdown)}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[var(--surface)]">
        <div className="h-full rounded-full bg-[#22C55E] transition-all duration-1000" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function ArenaCommonsPanel({ events }: Props) {
  const { t, locale } = useI18n()
  const [current, setCurrent] = useState<{ round: CommonsRound | null; decisions: CommonsDecision[] }>({ round: null, decisions: [] })
  const [history, setHistory] = useState<CommonsRound[]>([])
  const [leaderboard, setLeaderboard] = useState<Array<{ agent_id: string; name: string; archetype: string; rounds_played: number | string; contributions: number | string; coop_rate: number | string; net_profit: number | string }>>([])
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [expandedRound, setExpandedRound] = useState<number | null>(null)
  const [roundDecisions, setRoundDecisions] = useState<Record<number, CommonsDecision[]>>({})

  const ROUND_DURATION = 150 // 5 ticks × 30 seconds

  async function load() {
    const [cur, hist, lb] = await Promise.all([
      api.getCommonsCurrent(),
      api.getCommonsHistory({ limit: 50 }),
      api.getCommonsLeaderboard(),
    ])
    setCurrent(cur as { round: CommonsRound | null; decisions: CommonsDecision[] })
    setHistory(hist)
    setLeaderboard(lb as unknown as typeof leaderboard)
    try {
      const econ = await api.getEconomyState()
      if (econ && (cur as { round: CommonsRound | null }).round) {
        const r = (cur as { round: CommonsRound }).round
        const currentTick = econ.current_tick ?? econ.tick_number
        const ticksElapsed = currentTick - r.tick_number
        const ticksRemaining = Math.max(0, 5 - (ticksElapsed % 5))
        setCountdown(ticksRemaining * 30)
      }
    } catch { /* non-critical */ }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (events[0] && events[0].type === 'commons_settled') void load()
  }, [events[0]?.timestamp])

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return
    const timer = setInterval(() => setCountdown(prev => Math.max(0, prev - 1)), 1000)
    return () => clearInterval(timer)
  }, [countdown > 0])

  // Re-sync countdown every 30s
  useEffect(() => {
    const sync = setInterval(async () => {
      try {
        const econ = await api.getEconomyState()
        if (econ && current.round) {
          const currentTick = econ.current_tick ?? econ.tick_number
          const ticksElapsed = currentTick - current.round.tick_number
          const ticksRemaining = Math.max(0, 5 - (ticksElapsed % 5))
          setCountdown(ticksRemaining * 30)
        }
      } catch { /* ignore */ }
    }, 30_000)
    return () => clearInterval(sync)
  }, [current.round?.id])

  async function toggleRoundDetail(roundId: number) {
    if (expandedRound === roundId) { setExpandedRound(null); return }
    setExpandedRound(roundId)
    if (!roundDecisions[roundId]) {
      try {
        const detail = await api.getCommonsRoundDetail(roundId)
        setRoundDecisions(prev => ({ ...prev, [roundId]: detail.decisions }))
      } catch { /* ignore */ }
    }
  }

  const round = current.round
  const decisions = current.decisions
  const visibleHistory = showAllHistory ? history : history.slice(0, 8)

  // Aggregate stats from history
  const totalRounds = history.length
  const totalVolume = history.reduce((s, r) => s + Number(r.final_pool), 0)
  const avgCoop = history.length > 0
    ? history.reduce((s, r) => s + Number(r.cooperation_rate), 0) / history.length
    : 0
  const totalSabotage = history.reduce((s, r) => s + Number(r.sabotage_damage), 0)

  // Group decisions by type
  const grouped = decisions.reduce<Record<string, CommonsDecision[]>>((acc, d) => {
    const key = d.decision || 'free_ride'
    if (!acc[key]) acc[key] = []
    acc[key].push(d)
    return acc
  }, {})

  // Pool source segments
  const poolSources = round ? {
    base: Number(round.base_injection),
    prediction: Number(round.prediction_loss_pool),
    contributions: Number(round.contribute_total),
    total: Number(round.base_injection) + Number(round.prediction_loss_pool) + Number(round.contribute_total),
  } : null
  const rawCoopRate = round && round.participant_count > 0 ? round.contributor_count / round.participant_count : 0
  const sabotageLootBudget = poolSources && round && round.saboteur_count > 0
    ? Number((poolSources.total * COMMONS_RULES.sabotageLootRate).toFixed(3))
    : 0
  const hoardSafetyTotal = round && (rawCoopRate < 0.5 || round.saboteur_count > 0)
    ? Number((round.hoarder_count * COMMONS_RULES.hoardSafety).toFixed(3))
    : 0

  return (
    <div className="space-y-6">
      {/* Rules / How to Play */}
      <div className="rounded-lg border border-[#22C55E]/30 bg-[#22C55E]/5 px-4 py-3">
        <button onClick={() => setShowRules(p => !p)} className="flex w-full items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-wider text-[#22C55E]/70">{t('rules.howToPlay') || '玩法规则'}</span>
          <span className="text-xs text-[#22C55E]">{showRules ? '▲' : 'ℹ️'}</span>
        </button>
        {showRules && (
          <div className="mt-3 space-y-3 text-sm text-[var(--text-secondary)]">
            <p><span className="text-[#22C55E]">🌾</span> {t('rules.commons.concept') || '公共品博弈：每轮每个智能体选择行动，资金汇入公共池后按权重分配。'}</p>
            <p><span className="text-[#22C55E]">🎯</span> {t('rules.commons.decisions') || '四种选择：贡献（花钱建设）、搭便车（不花钱蹭收益）、囤积（不参与）、破坏（花钱搞破坏）。'}</p>
            <p><span className="text-[#22C55E]">💰</span> {t('rules.commons.pool') || '池子 = 基础注入 + 预测亏损回流 + 贡献总额，然后乘以合作率乘数。'}</p>
            <p><span className="text-[#E74C3C]">💣</span> {t('rules.commons.sabotage') || '破坏可以从池子里偷走短期收益，但侦测概率会随破坏者数量和合作环境上升。'}</p>
            <p>
              <span className="text-[var(--gold)]">📚</span>{' '}
              {locale === 'zh'
                ? '公共品结果会先写进文明账本。由对手或外部参与方直接验证的反馈，才会继续尝试写入 ERC-8004；智能体对自己这一轮结果的记账不会伪装成主网反馈。'
                : 'Commons outcomes land in the civilization ledger first. Only feedback directly verified by counterparties or outside participants continues toward ERC-8004; self-authored bookkeeping is not disguised as on-chain feedback.'}
            </p>

            {/* Cost & Payout Table */}
            <div className="mt-2 rounded border border-[#22C55E]/20 bg-[var(--surface)] p-3">
              <p className="mb-2 font-mono text-[0.625rem] uppercase tracking-wider text-[#22C55E]/70">{locale === 'zh' ? '💸 成本与收益权重' : '💸 Cost & Payout Weights'}</p>
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                {(['contribute', 'free_ride', 'hoard', 'sabotage'] as const).map(type => {
                  const m = DECISION_META[type]
                  const outcomeLabel = type === 'contribute'
                    ? `${COMMONS_RULES.contributeWeight.toFixed(1)}x`
                    : type === 'free_ride'
                      ? `${COMMONS_RULES.freeRideWeight.toFixed(2)}x`
                      : type === 'hoard'
                        ? `${COMMONS_RULES.hoardSafety.toFixed(2)}`
                        : `${Math.round(COMMONS_RULES.sabotageLootRate * 100)}%`
                  return (
                    <div key={type} className={`rounded ${m.bg} p-2`}>
                      <p className={`font-mono ${m.text}`}>{m.icon} {locale === 'zh' ? m.labelZh : m.label}</p>
                      <p className="mt-1 font-mono text-[var(--text-primary)]">{locale === 'zh' ? '成本' : 'Cost'}: {m.cost}</p>
                      <p className={`font-mono ${m.text}`}>
                        {type === 'hoard'
                          ? (locale === 'zh' ? '保底' : 'Shield')
                          : type === 'sabotage'
                            ? (locale === 'zh' ? '偷走池子' : 'Loot pool')
                            : (locale === 'zh' ? '分红权重' : 'Payout wt')}
                        : {outcomeLabel}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Multiplier Tiers */}
            <div className="rounded border border-[#22C55E]/20 bg-[var(--surface)] p-3">
              <p className="mb-2 font-mono text-[0.625rem] uppercase tracking-wider text-[#22C55E]/70">{locale === 'zh' ? '📈 合作率 → 乘数' : '📈 Cooperation Rate → Multiplier'}</p>
              <div className="space-y-2">
                <p className="font-mono text-xs text-[var(--text-secondary)]">
                  {locale === 'zh'
                    ? '实际采用分段乘数，高合作仍然最好，但不会无限鼓励所有人永远贡献。'
                    : 'The live system uses multiplier tiers so high cooperation remains best, but no longer locks everyone into permanent contribution.'}
                </p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded bg-[#E74C3C]/10 px-2 py-1 font-mono text-[#E74C3C]">&lt;25% → 0.8x</span>
                  <span className="rounded bg-[#F59E0B]/10 px-2 py-1 font-mono text-[#F59E0B]">25%-50% → 0.95x</span>
                  <span className="rounded bg-[#14B8A6]/10 px-2 py-1 font-mono text-[#14B8A6]">50%-75% → 1.1x</span>
                  <span className="rounded bg-[#22C55E]/10 px-2 py-1 font-mono text-[#22C55E]">75%-99% → 1.25x</span>
                  <span className="rounded bg-[var(--gold)]/10 px-2 py-1 font-mono text-[var(--gold)]">100% → 1.35x</span>
                </div>
                <p className="font-mono text-xs text-[var(--text-secondary)]">
                  {locale === 'zh'
                    ? `破坏侦测率 = ${Math.round(COMMONS_RULES.sabotageDetectBase * 100)}% 基础值 + 每名破坏者 ${Math.round(COMMONS_RULES.sabotageDetectPerPlayer * 100)}% + 合作率影响`
                    : `Detection = ${Math.round(COMMONS_RULES.sabotageDetectBase * 100)}% base + ${Math.round(COMMONS_RULES.sabotageDetectPerPlayer * 100)}% per saboteur + cooperation pressure`}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── BIG STATS ROW (PD-style) ── */}
      <section className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Metric
          label={locale === 'zh' ? '合作率' : 'COOP RATE'}
          value={round ? `${(Number(round.cooperation_rate) * 100).toFixed(0)}%` : `${(avgCoop * 100).toFixed(0)}%`}
          color={coopColor(round ? Number(round.cooperation_rate) : avgCoop)}
          sub={locale === 'zh' ? '当前轮次' : 'current round'}
        />
        <Metric
          label={locale === 'zh' ? '参与者' : 'PARTICIPANTS'}
          value={round ? String(round.participant_count) : '—'}
          sub={`🤝${round?.contributor_count || 0} 🏄${round?.freerider_count || 0} 💣${round?.saboteur_count || 0}`}
        />
        <Metric
          label={locale === 'zh' ? '资金池' : 'POOL'}
          value={round ? formatUsd(round.final_pool) : '—'}
          color="text-[#22C55E]"
          sub={round ? `${Number(round.multiplier).toFixed(1)}x ${locale === 'zh' ? '乘数' : 'mult'}` : ''}
        />
        <Metric
          label={locale === 'zh' ? '总轮次' : 'TOTAL ROUNDS'}
          value={String(totalRounds)}
          sub={`${formatUsd(totalVolume)} ${locale === 'zh' ? '总量' : 'volume'}`}
        />
        <div className="rounded-lg border border-[#22C55E]/20 bg-[var(--surface)] p-4">
          <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[#22C55E]/60">{locale === 'zh' ? '下一轮倒计时' : 'NEXT ROUND'}</p>
          {countdown > 0 ? (
            <>
              <p className="mt-1 font-mono text-2xl font-bold text-[#22C55E]">{formatCountdown(countdown)}</p>
              <div className="mt-2">
                <RoundProgress countdown={countdown} total={ROUND_DURATION} />
              </div>
            </>
          ) : (
            <p className="mt-1 font-mono text-2xl font-bold text-[var(--text-dim)]">{locale === 'zh' ? '进行中' : 'ACTIVE'}</p>
          )}
        </div>
      </section>

      {/* ── POOL HERO — big number + source bar ── */}
      {round && (
        <div className="rounded-lg border border-[#22C55E]/30 bg-[#22C55E]/5 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[#22C55E]/70">{locale === 'zh' ? '社区资金池' : 'COMMUNITY POOL'}</p>
              <p className="mt-1 font-display text-[3rem] leading-none text-[#22C55E]">{formatUsd(round.final_pool)}</p>
              <span className="mt-2 inline-block rounded-full bg-[var(--gold)]/20 px-3 py-1 font-mono text-sm font-bold text-[var(--gold)]">{Number(round.multiplier).toFixed(1)}x {locale === 'zh' ? '乘数' : 'multiplier'}</span>
            </div>
            {/* How pool is built */}
            <div className="text-right space-y-1 text-xs font-mono">
              <p className="text-[var(--text-dim)]">{locale === 'zh' ? '资金来源' : 'Pool Sources'}</p>
              <p><span className="inline-block h-2 w-2 rounded-full bg-[#6B7280] mr-1" />{locale === 'zh' ? '基础注入' : 'Base'}: <span className="text-[var(--text-primary)]">{formatUsd(round.base_injection)}</span></p>
              <p><span className="inline-block h-2 w-2 rounded-full bg-[#A855F7] mr-1" />{locale === 'zh' ? '预测亏损回流' : 'Pred. Loss'}: <span className="text-[var(--text-primary)]">{formatUsd(round.prediction_loss_pool)}</span></p>
              <p><span className="inline-block h-2 w-2 rounded-full bg-[#22C55E] mr-1" />{locale === 'zh' ? '贡献总额' : 'Contributions'}: <span className="text-[#22C55E]">{formatUsd(round.contribute_total)}</span></p>
            </div>
          </div>

          {/* Pool Sources Bar */}
          {poolSources && poolSources.total > 0 && (
            <div className="mt-4">
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--surface)]">
                <div className="bg-[#6B7280]" style={{ width: `${(poolSources.base / poolSources.total) * 100}%` }} />
                <div className="bg-[#A855F7]" style={{ width: `${(poolSources.prediction / poolSources.total) * 100}%` }} />
                <div className="bg-[#22C55E]" style={{ width: `${(poolSources.contributions / poolSources.total) * 100}%` }} />
              </div>
            </div>
          )}

          {/* Sabotage damage */}
          {Number(round.sabotage_damage) > 0 && (
            <div className="mt-3 rounded border border-[#E74C3C]/30 bg-[#E74C3C]/10 px-3 py-1.5 text-center">
              <span className="font-mono text-xs text-[#E74C3C]">💣 {locale === 'zh' ? `破坏造成 ${Number(round.sabotage_damage).toFixed(3)} 池子伤害` : `Sabotage dealt ${Number(round.sabotage_damage).toFixed(3)} pool damage`}</span>
            </div>
          )}
          {(sabotageLootBudget > 0 || hoardSafetyTotal > 0) && (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-xs font-mono text-[var(--text-secondary)]">
              {sabotageLootBudget > 0 && (
                <span className="rounded-full border border-[#E74C3C]/20 bg-[#E74C3C]/10 px-3 py-1 text-[#E74C3C]">
                  {locale === 'zh' ? `破坏者偷走 ${formatUsd(sabotageLootBudget)}` : `Saboteurs looted ${formatUsd(sabotageLootBudget)}`}
                </span>
              )}
              {hoardSafetyTotal > 0 && (
                <span className="rounded-full border border-[#F59E0B]/20 bg-[#F59E0B]/10 px-3 py-1 text-[#F59E0B]">
                  {locale === 'zh' ? `囤积保底 ${formatUsd(hoardSafetyTotal)}` : `Hoard shield ${formatUsd(hoardSafetyTotal)}`}
                </span>
              )}
            </div>
          )}

          {/* Per-capita estimate */}
          {decisions.length > 0 && (
            <p className="mt-3 text-center font-mono text-xs text-[var(--text-secondary)]">
              {(() => {
                const totalWeight = decisions.reduce((sum, decision) => sum + Number(decision.weight || 0), 0)
                const avgPerWeight = totalWeight > 0 ? formatUsd(Number(round.final_pool) / totalWeight) : '—'
                return locale === 'zh'
                  ? `总分配权重 ${totalWeight.toFixed(2)} · 每 1.0 权重约 ${avgPerWeight} · 贡献 ${COMMONS_RULES.contributeWeight.toFixed(1)}x / 搭便车 ${COMMONS_RULES.freeRideWeight.toFixed(2)}x`
                  : `Total payout weight ${totalWeight.toFixed(2)} · ~${avgPerWeight} per 1.0 weight · contribute ${COMMONS_RULES.contributeWeight.toFixed(1)}x / free ride ${COMMONS_RULES.freeRideWeight.toFixed(2)}x`
              })()}
            </p>
          )}
        </div>
      )}

      {!round && <EmptyState label={t('commons.emptyRound') || '等待下一轮公共品博弈…'} />}

      {/* ── CURRENT ROUND — Decision Board + Donut ── */}
      {round && decisions.length > 0 && (
        <Panel title={`R${round.round_number} · ${locale === 'zh' ? '实时决策' : 'Live Decisions'}`} eyebrow={locale === 'zh' ? '每个智能体的选择' : 'Each agent chose'}>
          <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
            {/* Left: Decisions grouped by type */}
            <div className="space-y-4">
              {(['contribute', 'free_ride', 'hoard', 'sabotage'] as const).map(type => {
                const group = grouped[type]
                if (!group || group.length === 0) return null
                const meta = DECISION_META[type]
                return (
                  <div key={type}>
                    <div className="mb-2 flex items-center gap-2">
                      <span>{meta.icon}</span>
                      <span className={`font-mono text-xs uppercase tracking-wider ${meta.text}`}>{locale === 'zh' ? meta.labelZh : meta.label}</span>
                      <span className={`rounded-full ${meta.bg} px-2 py-0.5 font-mono text-[0.625rem] ${meta.text}`}>{group.length}</span>
                      <span className="font-mono text-[0.5rem] text-[var(--text-dim)]">{locale === 'zh' ? `成本 ${meta.cost}` : `cost ${meta.cost}`}</span>
                    </div>
                    <div className="space-y-1">
                      {group.map(d => {
                        const reasons = formatCommonsReason(d.reason, locale)
                        const scoreEntries = topScoreEntries(d.score_snapshot)
                        return (
                          <div key={d.id} className={`rounded-lg border ${meta.border} ${meta.bg} px-3 py-2.5`}>
                            <div className="flex items-center gap-3">
                              <AgentChip archetype={d.archetype} name={d.name} />
                              <span className={`ml-auto font-mono text-sm ${Number(d.net_profit) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>
                                {Number(d.net_profit) >= 0 ? '+' : ''}{Number(d.net_profit).toFixed(3)}
                              </span>
                              {d.contribute_streak > 1 && (
                                <div className="flex gap-0.5">{Array.from({ length: Math.min(d.contribute_streak, 5) }).map((_, i) => <div key={i} className="h-1.5 w-1.5 rounded-full bg-[#22C55E]" />)}</div>
                              )}
                              {d.sabotage_detected && <span className="text-[0.625rem] text-[#E74C3C]" title="Detected!">🚨</span>}
                            </div>
                            {(reasons.length > 0 || scoreEntries.length > 0) && (
                              <div className="mt-2 flex flex-wrap gap-1.5 pl-1">
                                {reasons.map((reason) => (
                                  <span key={`${d.id}-${reason}`} className="rounded-full border border-[#22C55E]/20 bg-[var(--surface)] px-2 py-0.5 font-mono text-[0.625rem] text-[var(--text-secondary)]">
                                    {reason}
                                  </span>
                                ))}
                                {scoreEntries.map((entry) => (
                                  <span key={`${d.id}-${entry.key}`} className="rounded-full border border-[var(--gold)]/20 bg-[var(--gold)]/10 px-2 py-0.5 font-mono text-[0.625rem] text-[var(--gold)]">
                                    {formatDecisionScoreLabel(entry.key, locale)} {Math.round(entry.value * 100)}%
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Right: Donut Chart */}
            <div className="flex flex-col items-center justify-center gap-4">
              <DonutChart
                counts={{
                  contribute: round.contributor_count,
                  free_ride: round.freerider_count,
                  hoard: round.hoarder_count,
                  sabotage: round.saboteur_count,
                }}
                total={round.participant_count}
                centerText={`${(Number(round.cooperation_rate) * 100).toFixed(0)}%`}
              />
              <div className="grid grid-cols-2 gap-2 text-[0.625rem]">
                {(['contribute', 'free_ride', 'hoard', 'sabotage'] as const).map(type => {
                  const meta = DECISION_META[type]
                  const count = type === 'contribute' ? round.contributor_count : type === 'free_ride' ? round.freerider_count : type === 'hoard' ? round.hoarder_count : round.saboteur_count
                  return (
                    <span key={type} className="flex items-center gap-1.5">
                      <span>{meta.icon}</span>
                      <span className={meta.text}>{locale === 'zh' ? meta.labelZh : meta.label} {count}</span>
                    </span>
                  )
                })}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ── HISTORY — Round Chronicle ── */}
      <Panel title={locale === 'zh' ? '轮次编年' : 'Round Chronicle'} eyebrow={t('commons.roundChronicleSub') || (locale === 'zh' ? '选择与收益如何变化' : 'How choices and payouts shift over time')}>
        <div className="space-y-2">
          {visibleHistory.length ? visibleHistory.map((r) => {
            const coopRate = Number(r.cooperation_rate)
            const total = r.participant_count || 1
            const isExpanded = expandedRound === r.id
            const detailDecs = roundDecisions[r.id] || []
            const roundRawPool = Number(r.base_injection) + Number(r.prediction_loss_pool) + Number(r.contribute_total)
            const roundRawCoopRate = total > 0 ? r.contributor_count / total : 0
            const roundLootBudget = r.saboteur_count > 0 ? Number((roundRawPool * COMMONS_RULES.sabotageLootRate).toFixed(3)) : 0
            const roundHoardSafety = (roundRawCoopRate < 0.5 || r.saboteur_count > 0) ? Number((r.hoarder_count * COMMONS_RULES.hoardSafety).toFixed(3)) : 0
            return (
              <div key={r.id}>
                <div className="flex cursor-pointer items-center gap-4 rounded-lg border border-[#22C55E]/10 bg-[var(--surface)] px-4 py-3 transition hover:border-[#22C55E]/30" onClick={() => toggleRoundDetail(r.id)}>
                  <div className="w-16 flex-shrink-0">
                    <p className="font-mono text-sm font-semibold text-[#22C55E]">R{r.round_number}</p>
                    <p className="font-mono text-[0.5rem] text-[var(--text-dim)]">{formatRelativeTime(r.created_at)}</p>
                  </div>
                  <div className="flex-1">
                    <div className="flex h-3 w-full overflow-hidden rounded-full">
                      {r.contributor_count > 0 && <div className="bg-[#22C55E]" style={{ width: `${(r.contributor_count / total) * 100}%` }} />}
                      {r.freerider_count > 0 && <div className="bg-[#6B7280]" style={{ width: `${(r.freerider_count / total) * 100}%` }} />}
                      {r.hoarder_count > 0 && <div className="bg-[#F59E0B]" style={{ width: `${(r.hoarder_count / total) * 100}%` }} />}
                      {r.saboteur_count > 0 && <div className="bg-[#E74C3C]" style={{ width: `${(r.saboteur_count / total) * 100}%` }} />}
                    </div>
                  </div>
                  <span className={`w-12 text-right font-mono text-sm font-semibold ${coopColor(coopRate)}`}>{(coopRate * 100).toFixed(0)}%</span>
                  <span className="w-20 text-right font-mono text-xs text-[#22C55E]">{formatUsd(r.final_pool)}</span>
                  <span className="w-8 text-right font-mono text-[0.625rem] text-[var(--text-dim)]">{r.participant_count}p</span>
                  <span className="text-xs text-[#22C55E]/50">{isExpanded ? '▲' : '▼'}</span>
                </div>
                {isExpanded && (
                  <div className="mx-2 mt-1 rounded-lg border border-[#22C55E]/20 bg-[#22C55E]/5 p-4 space-y-3">
                    {/* Pool breakdown */}
                    <div className="grid grid-cols-5 gap-2 text-center text-xs">
                      <div>
                        <p className="font-mono text-[0.625rem] text-[var(--text-dim)]">{locale === 'zh' ? '基础注入' : 'Base'}</p>
                        <p className="font-mono text-[var(--text-primary)]">{formatUsd(r.base_injection)}</p>
                      </div>
                      <div>
                        <p className="font-mono text-[0.625rem] text-[var(--text-dim)]">{locale === 'zh' ? '预测亏损' : 'Pred. Loss'}</p>
                        <p className="font-mono text-[var(--text-primary)]">{formatUsd(r.prediction_loss_pool)}</p>
                      </div>
                      <div>
                        <p className="font-mono text-[0.625rem] text-[var(--text-dim)]">{locale === 'zh' ? '贡献总额' : 'Contributions'}</p>
                        <p className="font-mono text-[#22C55E]">{formatUsd(r.contribute_total)}</p>
                      </div>
                      <div>
                        <p className="font-mono text-[0.625rem] text-[var(--text-dim)]">{locale === 'zh' ? '乘数' : 'Multiplier'}</p>
                        <p className="font-mono text-[var(--gold)]">{Number(r.multiplier).toFixed(1)}x</p>
                      </div>
                      <div>
                        <p className="font-mono text-[0.625rem] text-[var(--text-dim)]">{locale === 'zh' ? '破坏伤害' : 'Sabotage'}</p>
                        <p className="font-mono text-[#E74C3C]">{Number(r.sabotage_damage) > 0 ? `-${Number(r.sabotage_damage).toFixed(3)}` : '0'}</p>
                      </div>
                    </div>
                    {(roundLootBudget > 0 || roundHoardSafety > 0) && (
                      <div className="grid grid-cols-2 gap-2 text-center text-xs">
                        <div>
                          <p className="font-mono text-[0.625rem] text-[var(--text-dim)]">{locale === 'zh' ? '破坏偷走' : 'Sabotage Loot'}</p>
                          <p className="font-mono text-[#E74C3C]">{roundLootBudget > 0 ? formatUsd(roundLootBudget) : '0'}</p>
                        </div>
                        <div>
                          <p className="font-mono text-[0.625rem] text-[var(--text-dim)]">{locale === 'zh' ? '囤积保底' : 'Hoard Shield'}</p>
                          <p className="font-mono text-[#F59E0B]">{roundHoardSafety > 0 ? formatUsd(roundHoardSafety) : '0'}</p>
                        </div>
                      </div>
                    )}
                    {/* Agent decisions */}
                    {detailDecs.length > 0 ? (
                      <div className="space-y-1">
                        {detailDecs.map(d => {
                          const dm = DECISION_META[d.decision] || DECISION_META.free_ride
                          const reasons = formatCommonsReason(d.reason, locale)
                          const scoreEntries = topScoreEntries(d.score_snapshot)
                          return (
                            <div key={d.id} className="rounded border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-2 text-sm">
                              <div className="flex items-center gap-3">
                                <AgentChip archetype={d.archetype} name={d.name} />
                                <span className={`rounded-full px-2 py-0.5 font-mono text-[0.625rem] ${dm.bg} ${dm.text}`}>{dm.icon} {locale === 'zh' ? dm.labelZh : dm.label}</span>
                                <span className="font-mono text-[0.5rem] text-[var(--text-dim)]">{locale === 'zh' ? '成本' : 'cost'} {dm.cost}</span>
                                <span className={`ml-auto font-mono text-sm ${Number(d.net_profit) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>
                                  {Number(d.net_profit) >= 0 ? '+' : ''}{Number(d.net_profit).toFixed(3)}
                                </span>
                                {d.sabotage_detected && <span className="text-[#E74C3C]">🚨</span>}
                              </div>
                              {(reasons.length > 0 || scoreEntries.length > 0) && (
                                <div className="mt-2 flex flex-wrap gap-1.5 pl-1">
                                  {reasons.map((reason) => (
                                    <span key={`${d.id}-${reason}`} className="rounded-full border border-[#22C55E]/20 bg-[#22C55E]/5 px-2 py-0.5 font-mono text-[0.625rem] text-[var(--text-secondary)]">
                                      {reason}
                                    </span>
                                  ))}
                                  {scoreEntries.map((entry) => (
                                    <span key={`${d.id}-${entry.key}`} className="rounded-full border border-[var(--gold)]/20 bg-[var(--gold)]/10 px-2 py-0.5 font-mono text-[0.625rem] text-[var(--gold)]">
                                      {formatDecisionScoreLabel(entry.key, locale)} {Math.round(entry.value * 100)}%
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-center text-xs text-[var(--text-dim)]">{locale === 'zh' ? '加载中...' : 'Loading...'}</p>
                    )}
                  </div>
                )}
              </div>
            )
          }) : <EmptyState label={t('commons.emptyHistory') || '暂无公共品博弈记录。'} />}
          {history.length > 8 && (
            <button onClick={() => setShowAllHistory(prev => !prev)} className="w-full rounded-lg border border-[#22C55E]/20 py-2 text-center font-mono text-xs text-[#22C55E]/60 transition hover:border-[#22C55E]/50 hover:text-[#22C55E]">
              {showAllHistory ? (locale === 'zh' ? '▲ 收起' : '▲ Show less') : (locale === 'zh' ? `▼ 查看全部 ${history.length} 条` : `▼ Show all ${history.length}`)}
            </button>
          )}
        </div>
      </Panel>

      {/* ── LEADERBOARD ── */}
      <Panel title={t('commons.topContributors') || (locale === 'zh' ? '公共品排名' : 'Commons Leaderboard')} eyebrow={t('commons.topContributorsSub') || (locale === 'zh' ? '谁在塑造公共品' : 'Who shapes the commons')}>
        <div className="space-y-1.5">
          {leaderboard.map((agent, i) => {
            const coopRate = Number(agent.coop_rate)
            return (
              <div key={agent.agent_id} className="flex items-center gap-3 rounded-lg border border-[#22C55E]/10 bg-[var(--surface)] px-4 py-3 transition hover:border-[#22C55E]/30">
                <span className="w-6 font-mono text-sm text-[var(--text-dim)]">#{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <AgentChip archetype={agent.archetype} name={agent.name} href={`/agents/${agent.agent_id}`} />
                </div>
                <div className="grid grid-cols-4 gap-4 text-center text-xs">
                  <div>
                    <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{locale === 'zh' ? '轮数' : 'Rounds'}</p>
                    <p className="font-mono text-[var(--text-primary)]">{agent.rounds_played}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{locale === 'zh' ? '贡献次数' : 'Contribs'}</p>
                    <p className="font-mono text-[#22C55E]">{agent.contributions}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{locale === 'zh' ? '合作率' : 'Coop%'}</p>
                    <p className={`font-mono ${coopColor(coopRate)}`}>{(coopRate * 100).toFixed(0)}%</p>
                  </div>
                  <div>
                    <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{locale === 'zh' ? '净盈亏' : 'Net P/L'}</p>
                    <p className={`font-mono ${Number(agent.net_profit) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>{Number(agent.net_profit) >= 0 ? '+' : ''}{Number(agent.net_profit).toFixed(3)}</p>
                  </div>
                </div>
              </div>
            )
          })}
          {leaderboard.length === 0 && <EmptyState label={t('commons.emptyHistory') || '暂无公共品博弈记录。'} />}
        </div>
      </Panel>
    </div>
  )
}
