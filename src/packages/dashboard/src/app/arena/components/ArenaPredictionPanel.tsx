'use client'

import { Fragment, useEffect, useState } from 'react'
import { api, PredictionRound, PredictionPosition, RealtimeEvent } from '@/lib/api'
import { AgentChip, EmptyState, Panel, formatRelativeTime, formatUsd, archetypeMeta } from '@/components/CivilisPrimitives'
import { formatDynamicNarrative } from '@/lib/dynamic-text'
import { useI18n } from '@/lib/i18n/index'

interface Props {
  events: RealtimeEvent[]
}

const POSITION_STYLES: Record<string, { bg: string; text: string; label: string; labelZh: string; arrow: string }> = {
  long_small:  { bg: 'bg-[#A855F7]/10', text: 'text-[#C084FC]', label: 'Long ↑', labelZh: '小额做多', arrow: '↑' },
  long_big:    { bg: 'bg-[#A855F7]/20', text: 'text-[#A855F7]', label: 'Long ↑↑', labelZh: '大额做多', arrow: '↑↑' },
  short_small: { bg: 'bg-[#EC4899]/10', text: 'text-[#F472B6]', label: 'Short ↓', labelZh: '小额做空', arrow: '↓' },
  short_big:   { bg: 'bg-[#EC4899]/20', text: 'text-[#EC4899]', label: 'Short ↓↓', labelZh: '大额做空', arrow: '↓↓' },
  hedge:       { bg: 'bg-[#6B7280]/10', text: 'text-[#9CA3AF]', label: 'Hedge ⇌', labelZh: '对冲', arrow: '⇌' },
}

const PHASE_STYLES: Record<string, { bg: string; text: string; label: string; labelZh: string }> = {
  predicting:     { bg: 'bg-[#A855F7]/20', text: 'text-[#A855F7]', label: 'PREDICTING', labelZh: '预测中' },
  waiting:        { bg: 'bg-[#F59E0B]/20', text: 'text-[#F59E0B]', label: 'WAITING', labelZh: '等待中' },
  settled:        { bg: 'bg-[#22C55E]/20', text: 'text-[#22C55E]', label: 'SETTLED', labelZh: '已结算' },
  flash_settled:  { bg: 'bg-[#EAB308]/20', text: 'text-[#EAB308]', label: '⚡ FLASH', labelZh: '⚡ 闪电' },
}

function coinSymbol(pair: string): string {
  return pair.replace('-USDT', '')
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/* Stat Card */
function Metric({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-[#A855F7]/20 bg-[var(--surface)] p-4">
      <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/60">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-bold ${color || 'text-[var(--text-primary)]'}`}>{value}</p>
      {sub && <p className="mt-0.5 font-mono text-[0.5rem] text-[var(--text-dim)]">{sub}</p>}
    </div>
  )
}

/* SVG Price Sparkline with position markers */
function PriceChart({
  priceHistoryA, priceHistoryB,
  coinA, coinB,
  positions, round, locale
}: {
  priceHistoryA: Array<{ price: string; tick_number: number }>
  priceHistoryB: Array<{ price: string; tick_number: number }>
  coinA: string; coinB: string
  positions: PredictionPosition[]
  round: PredictionRound
  locale: string
}) {
  if (priceHistoryA.length < 2 && priceHistoryB.length < 2) return null

  const W = 560, H = 180, PAD = 30

  function normalize(data: Array<{ price: string; tick_number: number }>) {
    const prices = data.map(d => parseFloat(d.price))
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    const range = max - min || 1
    return { prices, min, max, range }
  }

  // Normalize each coin to 0-100% scale for comparison
  const nA = normalize(priceHistoryA)
  const nB = normalize(priceHistoryB)

  const allTicks = [...new Set([...priceHistoryA.map(d => d.tick_number), ...priceHistoryB.map(d => d.tick_number)])].sort((a, b) => a - b)
  const minTick = allTicks[0] || 0
  const maxTick = allTicks[allTicks.length - 1] || 1
  const tickRange = maxTick - minTick || 1

  function toX(tick: number) { return PAD + ((tick - minTick) / tickRange) * (W - PAD * 2) }
  function toY(price: number, n: { min: number; range: number }) {
    return H - PAD - ((price - n.min) / n.range) * (H - PAD * 2)
  }

  function makePath(data: Array<{ price: string; tick_number: number }>, n: { min: number; range: number }) {
    return data.map((d, i) => {
      const x = toX(d.tick_number)
      const y = toY(parseFloat(d.price), n)
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    }).join(' ')
  }

  const pathA = makePath(priceHistoryA, nA)
  const pathB = makePath(priceHistoryB, nB)

  // Start price baselines
  const startPriceA = parseFloat(String(round.start_price_a))
  const startPriceB = parseFloat(String(round.start_price_b))
  const startY_A = toY(startPriceA, nA)
  const startY_B = toY(startPriceB, nB)

  // Position markers at round start tick
  const startTick = round.start_tick
  const startX = toX(startTick)

  return (
    <div className="rounded-lg border border-[#A855F7]/20 bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/70">{locale === 'zh' ? '价格走势' : 'PRICE CHART'}</p>
        <div className="flex gap-3 text-[0.625rem] font-mono">
          <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-4 rounded bg-[#A855F7]" /> {coinSymbol(coinA)}</span>
          <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-4 rounded bg-[#EC4899]" /> {coinSymbol(coinB)}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 200 }}>
        {/* Start price baselines */}
        <line x1={PAD} y1={startY_A} x2={W - PAD} y2={startY_A} stroke="#A855F7" strokeWidth="0.5" strokeDasharray="4,4" opacity="0.3" />
        <line x1={PAD} y1={startY_B} x2={W - PAD} y2={startY_B} stroke="#EC4899" strokeWidth="0.5" strokeDasharray="4,4" opacity="0.3" />

        {/* Round start vertical line */}
        {startX >= PAD && startX <= W - PAD && (
          <line x1={startX} y1={PAD} x2={startX} y2={H - PAD} stroke="#ffffff" strokeWidth="0.5" strokeDasharray="2,4" opacity="0.2" />
        )}

        {/* Price lines */}
        <path d={pathA} fill="none" stroke="#A855F7" strokeWidth="2" />
        <path d={pathB} fill="none" stroke="#EC4899" strokeWidth="2" />

        {/* Current price dots */}
        {priceHistoryA.length > 0 && (() => {
          const last = priceHistoryA[priceHistoryA.length - 1]
          return <circle cx={toX(last.tick_number)} cy={toY(parseFloat(last.price), nA)} r="4" fill="#A855F7" />
        })()}
        {priceHistoryB.length > 0 && (() => {
          const last = priceHistoryB[priceHistoryB.length - 1]
          return <circle cx={toX(last.tick_number)} cy={toY(parseFloat(last.price), nB)} r="4" fill="#EC4899" />
        })()}

        {/* Position entry markers */}
        {positions.map((p, i) => {
          const ps = POSITION_STYLES[p.position_type] || POSITION_STYLES.hedge
          const isA = p.chosen_coin === 'coin_a'
          const n = isA ? nA : nB
          const entryPrice = isA ? startPriceA : startPriceB
          const x = startX >= PAD ? startX : PAD + 10
          const y = toY(entryPrice, n)
          const color = isA ? '#A855F7' : '#EC4899'
          const yOffset = i * 14

          return (
            <g key={p.id}>
              <circle cx={x} cy={y} r="3" fill={color} stroke="#fff" strokeWidth="0.5" opacity="0.8" />
              <text x={x + 6} y={y + yOffset - 2} fill={color} fontSize="8" fontFamily="monospace">{p.name?.slice(0, 6)} {ps.arrow}</text>
            </g>
          )
        })}

        {/* Y-axis labels */}
        <text x={2} y={PAD + 4} fill="#A855F7" fontSize="7" fontFamily="monospace" opacity="0.6">${nA.max < 100 ? nA.max.toFixed(1) : Math.round(nA.max)}</text>
        <text x={2} y={H - PAD + 4} fill="#A855F7" fontSize="7" fontFamily="monospace" opacity="0.6">${nA.min < 100 ? nA.min.toFixed(1) : Math.round(nA.min)}</text>
        <text x={W - PAD + 4} y={PAD + 4} fill="#EC4899" fontSize="7" fontFamily="monospace" opacity="0.6">${nB.max < 100 ? nB.max.toFixed(1) : Math.round(nB.max)}</text>
        <text x={W - PAD + 4} y={H - PAD + 4} fill="#EC4899" fontSize="7" fontFamily="monospace" opacity="0.6">${nB.min < 100 ? nB.min.toFixed(1) : Math.round(nB.min)}</text>
      </svg>
    </div>
  )
}

export default function ArenaPredictionPanel({ events }: Props) {
  const { t, locale } = useI18n()
  const [current, setCurrent] = useState<{ round: PredictionRound | null; positions: PredictionPosition[] }>({ round: null, positions: [] })
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [history, setHistory] = useState<PredictionRound[]>([])
  const [leaderboard, setLeaderboard] = useState<Array<{ agent_id: string; name: string; archetype: string; rounds_played: number | string; correct: number | string; accuracy: number | string; net_pnl: number | string }>>([])
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [expandedRound, setExpandedRound] = useState<number | null>(null)
  const [roundPositions, setRoundPositions] = useState<Record<number, PredictionPosition[]>>({})
  const [priceHistoryA, setPriceHistoryA] = useState<Array<{ price: string; tick_number: number }>>([])
  const [priceHistoryB, setPriceHistoryB] = useState<Array<{ price: string; tick_number: number }>>([])

  const ROUND_DURATION = 300 // 10 ticks × 30 seconds = 5 minutes

  async function load() {
    const [cur, pr, hist, lb] = await Promise.all([
      api.getPredictionCurrent(),
      api.getPredictionPrices(),
      api.getPredictionHistory({ limit: 50 }),
      api.getPredictionLeaderboard(),
    ])
    setCurrent(cur as { round: PredictionRound | null; positions: PredictionPosition[] })
    setPrices((pr as { prices: Record<string, number> }).prices || {})
    setHistory(hist)
    setLeaderboard(lb as unknown as typeof leaderboard)

    // Load price history for chart
    const round = (cur as { round: PredictionRound | null }).round
    if (round) {
      try {
        const [phA, phB] = await Promise.all([
          api.getPredictionPriceHistory(round.coin_a, 30),
          api.getPredictionPriceHistory(round.coin_b, 30),
        ])
        setPriceHistoryA(phA)
        setPriceHistoryB(phB)
      } catch { /* chart is non-critical */ }
    }

    try {
      const econ = await api.getEconomyState()
      if (econ && round) {
        const currentTick = econ.current_tick ?? econ.tick_number
        const secs = Math.max(0, (round.end_tick - currentTick) * 30)
        setCountdown(secs)
      }
    } catch { /* non-critical */ }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (events[0] && ['prediction_created', 'prediction_settled'].includes(events[0].type)) void load()
  }, [events[0]?.timestamp])

  // Auto-refresh prices every 30s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const pr = await api.getPredictionPrices()
        setPrices((pr as { prices: Record<string, number> }).prices || {})
        // Also refresh chart data
        if (current.round) {
          const [phA, phB] = await Promise.all([
            api.getPredictionPriceHistory(current.round.coin_a, 30),
            api.getPredictionPriceHistory(current.round.coin_b, 30),
          ])
          setPriceHistoryA(phA)
          setPriceHistoryB(phB)
        }
      } catch { /* ignore */ }
    }, 30_000)
    return () => clearInterval(interval)
  }, [current.round?.id])

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
          const secs = Math.max(0, (current.round.end_tick - currentTick) * 30)
          setCountdown(secs)
        }
      } catch { /* ignore */ }
    }, 30_000)
    return () => clearInterval(sync)
  }, [current.round?.id])

  async function toggleRoundDetail(roundId: number) {
    if (expandedRound === roundId) { setExpandedRound(null); return }
    setExpandedRound(roundId)
    if (!roundPositions[roundId]) {
      try {
        const detail = await api.getPredictionRoundDetail(roundId)
        setRoundPositions(prev => ({ ...prev, [roundId]: detail.positions }))
      } catch { /* ignore */ }
    }
  }

  const round = current.round
  const positions = current.positions
  const visibleHistory = showAllHistory ? history : history.slice(0, 8)

  // Aggregate stats
  const totalRounds = history.length
  const totalVolume = history.reduce((s, r) => s + Number(r.prize_pool), 0)
  const flashCount = history.filter(r => r.flash_settled).length
  const entryFee = positions.length > 0 ? Number(positions[0].entry_fee) : 0.3

  return (
    <div className="space-y-6">
      {/* Rules / How to Play */}
      <div className="rounded-lg border border-[#A855F7]/30 bg-[#A855F7]/5 px-4 py-3">
        <button onClick={() => setShowRules(p => !p)} className="flex w-full items-center justify-between">
          <span className="font-mono text-xs uppercase tracking-wider text-[#A855F7]/70">{t('rules.howToPlay') || '玩法规则'}</span>
          <span className="text-xs text-[#A855F7]">{showRules ? '▲' : 'ℹ️'}</span>
        </button>
        {showRules && (
          <div className="mt-3 space-y-3 text-sm text-[var(--text-secondary)]">
            <p><span className="text-[#A855F7]">🔮</span> {t('rules.prediction.concept') || '预测两个代币谁涨更多，选择做多/做空/对冲。'}</p>
            <p><span className="text-[#A855F7]">📊</span> {t('rules.prediction.positions') || '5种仓位：小额做多(1.2x)、大额做多(2.5x)、小额做空(1.2x)、大额做空(2.5x)、对冲(0.3x稳赚)。'}</p>
            <p><span className="text-[#A855F7]">⏱</span> {t('rules.prediction.settlement') || '每轮持续5分钟（10个tick），根据价格变化结算盈亏。'}</p>
            <p><span className="text-[#EAB308]">⚡</span> {t('rules.prediction.flash') || '当两币价格差异超过1%时触发闪电结算。'}</p>

            {/* Entry Fee & Pool Distribution */}
            <div className="mt-2 rounded border border-[#A855F7]/20 bg-[var(--surface)] p-3">
              <p className="mb-2 font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/70">{locale === 'zh' ? '🎟️ 门票与资金分配' : '🎟️ Entry Fee & Pool'}</p>
              <div className="flex gap-4 text-xs font-mono">
                <div className="rounded bg-[#A855F7]/10 px-3 py-2 text-center">
                  <p className="text-[#A855F7]">{locale === 'zh' ? '门票' : 'Entry Fee'}</p>
                  <p className="text-lg font-bold text-[var(--text-primary)]">0.3 <span className="text-[0.625rem] text-[var(--text-dim)]">USDT</span></p>
                  <p className="text-[0.5rem] text-[var(--text-dim)]">{locale === 'zh' ? '繁荣期 0.39 / 危机期 0.21' : 'Boom 0.39 / Crisis 0.21'}</p>
                </div>
                <div className="rounded bg-[var(--gold)]/10 px-3 py-2 text-center">
                  <p className="text-[var(--gold)]">{locale === 'zh' ? '国库抽成' : 'Treasury Cut'}</p>
                  <p className="text-lg font-bold text-[var(--text-primary)]">25%</p>
                </div>
                <div className="rounded bg-[#22C55E]/10 px-3 py-2 text-center">
                  <p className="text-[#22C55E]">{locale === 'zh' ? '回流公共池' : 'Commons Return'}</p>
                  <p className="text-lg font-bold text-[var(--text-primary)]">30%</p>
                  <p className="text-[0.5rem] text-[var(--text-dim)]">{locale === 'zh' ? '亏损的30%回流' : '30% of losses'}</p>
                </div>
              </div>
            </div>

            {/* Position Odds */}
            <div className="rounded border border-[#A855F7]/20 bg-[var(--surface)] p-3">
              <p className="mb-2 font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/70">{locale === 'zh' ? '📈 仓位赔率' : '📈 Position Odds'}</p>
              <div className="grid grid-cols-5 gap-1.5 text-center text-[0.625rem]">
                <div className="rounded bg-[#A855F7]/10 p-1.5">
                  <p className="font-mono text-[#C084FC]">Long ↑</p>
                  <p className="font-mono font-bold text-[var(--text-primary)]">1.2x</p>
                  <p className="text-[#22C55E]">{locale === 'zh' ? '猜对全赚' : 'Win full'}</p>
                </div>
                <div className="rounded bg-[#A855F7]/20 p-1.5">
                  <p className="font-mono text-[#A855F7]">Long ↑↑</p>
                  <p className="font-mono font-bold text-[var(--text-primary)]">2.5x</p>
                  <p className="text-[#22C55E]">{locale === 'zh' ? '猜对全赚' : 'Win full'}</p>
                </div>
                <div className="rounded bg-[#EC4899]/10 p-1.5">
                  <p className="font-mono text-[#F472B6]">Short ↓</p>
                  <p className="font-mono font-bold text-[var(--text-primary)]">1.2x</p>
                  <p className="text-[#22C55E]">{locale === 'zh' ? '猜对全赚' : 'Win full'}</p>
                </div>
                <div className="rounded bg-[#EC4899]/20 p-1.5">
                  <p className="font-mono text-[#EC4899]">Short ↓↓</p>
                  <p className="font-mono font-bold text-[var(--text-primary)]">2.5x</p>
                  <p className="text-[#22C55E]">{locale === 'zh' ? '猜对全赚' : 'Win full'}</p>
                </div>
                <div className="rounded bg-[#6B7280]/10 p-1.5">
                  <p className="font-mono text-[#9CA3AF]">Hedge ⇌</p>
                  <p className="font-mono font-bold text-[var(--text-primary)]">0.3x</p>
                  <p className="text-[#F59E0B]">{locale === 'zh' ? '稳赚' : 'Always'}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── BIG STATS ROW (PD-style) ── */}
      <section className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Metric
          label={locale === 'zh' ? '总轮次' : 'TOTAL ROUNDS'}
          value={String(totalRounds)}
          sub={`${formatUsd(totalVolume)} ${locale === 'zh' ? '总量' : 'volume'}`}
        />
        <Metric
          label={locale === 'zh' ? '门票' : 'ENTRY FEE'}
          value={`${entryFee.toFixed(2)}`}
          color="text-[#A855F7]"
          sub="USDT"
        />
        <Metric
          label={locale === 'zh' ? '奖金池' : 'PRIZE POOL'}
          value={round ? formatUsd(round.prize_pool) : '—'}
          color="text-[var(--gold)]"
          sub={round ? `${positions.length} ${locale === 'zh' ? '人参与' : 'agents'}` : ''}
        />
        <Metric
          label={locale === 'zh' ? '闪电结算' : 'FLASH ⚡'}
          value={String(flashCount)}
          color="text-[#EAB308]"
          sub={`/ ${totalRounds} ${locale === 'zh' ? '轮' : 'rounds'}`}
        />
        <div className="rounded-lg border border-[#A855F7]/20 bg-[var(--surface)] p-4">
          <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/60">{locale === 'zh' ? '倒计时' : 'COUNTDOWN'}</p>
          {round && (round.phase === 'predicting' || round.phase === 'waiting') && countdown > 0 ? (
            <>
              <p className="mt-1 font-mono text-2xl font-bold text-[#A855F7]">{formatCountdown(countdown)}</p>
              <div className="mt-2">
                <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-alt,#1a1a2e)]">
                  <div className="h-full rounded-full bg-[#A855F7] transition-all duration-1000" style={{ width: `${Math.max(0, ((ROUND_DURATION - countdown) / ROUND_DURATION) * 100)}%` }} />
                </div>
              </div>
            </>
          ) : round?.phase === 'settled' || round?.flash_settled ? (
            <p className="mt-1 font-mono text-2xl font-bold text-[#22C55E]">{locale === 'zh' ? '已结算' : 'SETTLED'}</p>
          ) : (
            <p className="mt-1 font-mono text-2xl font-bold text-[var(--text-dim)]">—</p>
          )}
        </div>
      </section>

      {/* ── LIVE PRICE TICKER ── */}
      <section className="grid gap-3 grid-cols-3">
        {Object.entries(prices).map(([pair, price]) => {
          const isActive = round && (round.coin_a === pair || round.coin_b === pair)
          return (
            <div key={pair} className={`rounded-lg border p-4 text-center ${isActive ? 'border-[#A855F7]/50 bg-[#A855F7]/10 shadow-[0_0_16px_rgba(168,85,247,0.12)]' : 'border-[#A855F7]/20 bg-[var(--surface)]'}`}>
              <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/70">{coinSymbol(pair)}</p>
              <p className="mt-1 font-mono text-3xl font-bold text-[var(--text-primary)]">
                ${price < 100 ? price.toFixed(2) : price.toLocaleString('en', { maximumFractionDigits: 1 })}
              </p>
              <p className="mt-0.5 font-mono text-[0.5rem] text-[var(--text-dim)]">USDT {isActive ? (round.coin_a === pair ? '(A)' : '(B)') : ''}</p>
            </div>
          )
        })}
      </section>

      {/* ── PRICE CHART ── */}
      {round && (priceHistoryA.length > 1 || priceHistoryB.length > 1) && (
        <PriceChart
          priceHistoryA={priceHistoryA}
          priceHistoryB={priceHistoryB}
          coinA={round.coin_a}
          coinB={round.coin_b}
          positions={positions}
          round={round}
          locale={locale}
        />
      )}

      {/* ── ACTIVE ROUND — Coin Matchup + Positions ── */}
      <Panel title={locale === 'zh' ? '当前轮次' : 'Active Round'} eyebrow={locale === 'zh' ? '当前神谕视野' : 'Oracle vision'}>
        {round ? (
          <div className="space-y-4">
            {/* Flash Settlement Banner */}
            {round.flash_settled && (
              <div className="rounded-lg border border-[#EAB308]/40 bg-[#EAB308]/10 px-4 py-2 text-center">
                <span className="font-mono text-sm font-bold text-[#EAB308]">⚡ {locale === 'zh' ? '闪电结算' : 'Flash Settlement'} — {Number(round.relative_diff).toFixed(2)}% {locale === 'zh' ? '差异' : 'diff'}</span>
              </div>
            )}

            <div className="grid gap-6 lg:grid-cols-[1fr,1.2fr]">
              {/* Left: Coin Matchup */}
              <div className="rounded-lg border border-[#A855F7]/20 bg-[#A855F7]/5 p-5">
                <div className="flex items-center justify-center gap-4">
                  <div className="text-center">
                    <p className="font-mono text-3xl font-bold text-[#A855F7]">{coinSymbol(round.coin_a)}</p>
                    <p className="mt-1 font-mono text-sm text-[var(--text-secondary)]">${Number(round.start_price_a).toFixed(2)}</p>
                    {round.end_price_a && (
                      <p className={`mt-0.5 font-mono text-sm font-semibold ${Number(round.change_pct_a) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>
                        {Number(round.change_pct_a) >= 0 ? '+' : ''}{Number(round.change_pct_a).toFixed(2)}%
                      </p>
                    )}
                  </div>
                  <span className="font-display text-3xl text-[var(--text-dim)]">VS</span>
                  <div className="text-center">
                    <p className="font-mono text-3xl font-bold text-[#EC4899]">{coinSymbol(round.coin_b)}</p>
                    <p className="mt-1 font-mono text-sm text-[var(--text-secondary)]">${Number(round.start_price_b).toFixed(2)}</p>
                    {round.end_price_b && (
                      <p className={`mt-0.5 font-mono text-sm font-semibold ${Number(round.change_pct_b) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>
                        {Number(round.change_pct_b) >= 0 ? '+' : ''}{Number(round.change_pct_b).toFixed(2)}%
                      </p>
                    )}
                  </div>
                </div>

                {/* Phase + Prize */}
                <div className="mt-4 flex items-center justify-center gap-4">
                  {(() => {
                    const phase = round.flash_settled ? 'flash_settled' : round.phase
                    const ps = PHASE_STYLES[phase] || PHASE_STYLES.predicting
                    return <span className={`rounded-full px-3 py-1 font-mono text-xs font-semibold ${ps.bg} ${ps.text}`}>{locale === 'zh' ? ps.labelZh : ps.label}</span>
                  })()}
                  <span className="font-mono text-xs text-[var(--text-dim)]">{locale === 'zh' ? '奖金池' : 'Pool'}: <span className="text-[var(--gold)]">{formatUsd(round.prize_pool)}</span></span>
                </div>

                {/* Financial breakdown */}
                <div className="mt-3 flex justify-center gap-4 text-[0.625rem] font-mono text-[var(--text-dim)]">
                  <span>🎟️ {formatUsd(entryFee)}</span>
                  <span>🏛️ {round.treasury_cut ? formatUsd(round.treasury_cut) : '25%'}</span>
                  <span>🌾 {round.pg_return ? formatUsd(round.pg_return) : '30%'}</span>
                  <span>👥 {positions.length}</span>
                </div>

                {round.actual_winner && (
                  <div className="mt-3 text-center">
                    <p className="font-mono text-xs text-[var(--text-dim)]">{locale === 'zh' ? '胜出' : 'Winner'}:</p>
                    <p className="font-mono text-2xl font-bold text-[#22C55E]">
                      {coinSymbol(round.actual_winner === 'coin_a' ? round.coin_a : round.coin_b)}
                    </p>
                  </div>
                )}
              </div>

              {/* Right: Position Cards */}
              <div className="space-y-2">
                {positions.length > 0 ? positions.map((p) => {
                  const ps = POSITION_STYLES[p.position_type] || POSITION_STYLES.hedge
                  const chosenCoinName = coinSymbol(p.chosen_coin === 'coin_a' ? round.coin_a : round.coin_b)
                  const meta = archetypeMeta[p.archetype] || archetypeMeta.echo
                  return (
                    <div key={p.id} className={`rounded-lg border border-[#A855F7]/15 ${ps.bg} px-4 py-3`}>
                      <div className="flex items-center gap-3">
                        <div className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: meta.color }} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[var(--text-primary)]">{p.name}</p>
                          <p className="font-mono text-[0.5rem] uppercase tracking-widest" style={{ color: meta.color }}>{p.archetype}</p>
                        </div>
                        <span className="rounded border border-[#A855F7]/30 px-2 py-0.5 font-mono text-[0.625rem] text-[#A855F7]">{chosenCoinName}</span>
                        <span className={`rounded-full px-2 py-0.5 font-mono text-[0.625rem] font-semibold ${ps.bg} ${ps.text}`}>
                          {locale === 'zh' ? ps.labelZh : ps.label}
                        </span>
                        <span className="font-mono text-[0.625rem] text-[var(--text-dim)]">{Number(p.base_odds).toFixed(1)}x</span>
                        {p.final_pnl !== null && p.final_pnl !== undefined && (
                          <span className={`font-mono text-sm font-semibold ${Number(p.final_pnl) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>
                            {Number(p.final_pnl) >= 0 ? '+' : ''}{Number(p.final_pnl).toFixed(3)}
                          </span>
                        )}
                      </div>
                      {p.reasoning && (
                        <p
                          className="mt-1.5 ml-6 truncate text-[0.625rem] italic text-[var(--text-dim)]"
                          title={formatDynamicNarrative(p.reasoning, locale === 'zh')}
                        >
                          {formatDynamicNarrative(p.reasoning, locale === 'zh')}
                        </p>
                      )}
                    </div>
                  )
                }) : (
                  <div className="flex h-32 items-center justify-center text-sm text-[var(--text-dim)]">
                    {locale === 'zh' ? '暂无持仓' : 'No positions yet'}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState label={locale === 'zh' ? '神谕正在冥想中…' : 'The Oracle is meditating...'} />
        )}
      </Panel>

      {/* ── HISTORY — Oracle Ledger with click-to-expand ── */}
      <Panel title={locale === 'zh' ? '神谕账本' : 'Oracle Ledger'} eyebrow={locale === 'zh' ? '结算历史' : 'Settlement history'}>
        <div className="overflow-x-auto">
          {visibleHistory.length > 0 ? (
            <>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#A855F7]/20">
                    <th className="pb-2 text-left font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/50">{locale === 'zh' ? '轮次' : 'Round'}</th>
                    <th className="pb-2 text-left font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/50">{locale === 'zh' ? '交易对' : 'Pair'}</th>
                    <th className="pb-2 text-center font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/50">{locale === 'zh' ? '胜出' : 'Winner'}</th>
                    <th className="pb-2 text-right font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/50">{locale === 'zh' ? '差异' : 'Diff %'}</th>
                    <th className="pb-2 text-right font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/50">{locale === 'zh' ? '奖金池' : 'Pool'}</th>
                    <th className="pb-2 text-center font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/50">⚡</th>
                    <th className="pb-2 text-right font-mono text-[0.625rem] uppercase tracking-wider text-[#A855F7]/50">{locale === 'zh' ? '时间' : 'Time'}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHistory.map((r) => {
                    const winnerCoin = r.actual_winner === 'coin_a' ? r.coin_a : r.actual_winner === 'coin_b' ? r.coin_b : '—'
                    const isExpanded = expandedRound === r.id
                    const detailPositions = roundPositions[r.id] || []
                    return (
                      <Fragment key={r.id}>
                        <tr className="cursor-pointer border-b border-[var(--border-secondary)] transition hover:bg-[#A855F7]/5" onClick={() => toggleRoundDetail(r.id)}>
                          <td className="py-2 font-mono text-sm text-[#A855F7]">R{r.round_number}</td>
                          <td className="py-2 font-mono text-xs text-[var(--text-secondary)]">{coinSymbol(r.coin_a)} / {coinSymbol(r.coin_b)}</td>
                          <td className="py-2 text-center font-mono text-sm font-semibold text-[#22C55E]">{coinSymbol(winnerCoin)}</td>
                          <td className="py-2 text-right font-mono text-xs text-[var(--text-secondary)]">{r.relative_diff !== null ? `${Number(r.relative_diff).toFixed(2)}%` : '—'}</td>
                          <td className="py-2 text-right font-mono text-xs text-[var(--gold)]">{formatUsd(r.prize_pool)}</td>
                          <td className="py-2 text-center">{r.flash_settled ? <span className="text-[#EAB308]">⚡</span> : <span className="text-[var(--text-dim)]">·</span>}</td>
                          <td className="py-2 text-right font-mono text-[0.625rem] text-[var(--text-dim)]">
                            {r.settled_at ? formatRelativeTime(r.settled_at) : formatRelativeTime(r.created_at)}
                            <span className="ml-2 text-[#A855F7]/50">{isExpanded ? '▲' : '▼'}</span>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${r.id}-detail`}>
                            <td colSpan={7} className="pb-3 pt-1">
                              <div className="rounded-lg border border-[#A855F7]/20 bg-[#A855F7]/5 p-4 space-y-3">
                                {/* Price Changes */}
                                <div className="flex justify-center gap-8 text-sm">
                                  <div className="text-center">
                                    <p className="font-mono text-xs text-[var(--text-dim)]">{coinSymbol(r.coin_a)}</p>
                                    <p className="font-mono text-[var(--text-secondary)]">${Number(r.start_price_a).toFixed(2)} → {r.end_price_a ? `$${Number(r.end_price_a).toFixed(2)}` : '...'}</p>
                                    {r.change_pct_a && <p className={`font-mono text-xs ${Number(r.change_pct_a) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>{Number(r.change_pct_a) >= 0 ? '+' : ''}{Number(r.change_pct_a).toFixed(2)}%</p>}
                                  </div>
                                  <div className="text-center">
                                    <p className="font-mono text-xs text-[var(--text-dim)]">{coinSymbol(r.coin_b)}</p>
                                    <p className="font-mono text-[var(--text-secondary)]">${Number(r.start_price_b).toFixed(2)} → {r.end_price_b ? `$${Number(r.end_price_b).toFixed(2)}` : '...'}</p>
                                    {r.change_pct_b && <p className={`font-mono text-xs ${Number(r.change_pct_b) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>{Number(r.change_pct_b) >= 0 ? '+' : ''}{Number(r.change_pct_b).toFixed(2)}%</p>}
                                  </div>
                                </div>
                                {/* Financial breakdown */}
                                <div className="flex justify-center gap-6 text-[0.625rem] font-mono">
                                  <span className="text-[var(--text-dim)]">{locale === 'zh' ? '奖金池' : 'Pool'}: <span className="text-[var(--gold)]">{formatUsd(r.prize_pool)}</span></span>
                                  <span className="text-[var(--text-dim)]">{locale === 'zh' ? '国库' : 'Treasury'}: <span className="text-[var(--gold)]">{r.treasury_cut ? formatUsd(r.treasury_cut) : '—'}</span></span>
                                  <span className="text-[var(--text-dim)]">{locale === 'zh' ? '回流' : 'Commons'}: <span className="text-[#22C55E]">{r.pg_return ? formatUsd(r.pg_return) : '—'}</span></span>
                                </div>
                                {/* Positions */}
                                {detailPositions.length > 0 ? (
                                  <div className="space-y-1.5">
                                    {detailPositions.map((p) => {
                                      const ps = POSITION_STYLES[p.position_type] || POSITION_STYLES.hedge
                                      const chosenCoinName = coinSymbol(p.chosen_coin === 'coin_a' ? r.coin_a : r.coin_b)
                                      return (
                                        <div key={p.id} className="flex items-center gap-3 rounded border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-2 text-sm">
                                          <AgentChip archetype={p.archetype} name={p.name} />
                                          <span className="rounded border border-[#A855F7]/30 px-2 py-0.5 font-mono text-[0.625rem] text-[#A855F7]">{chosenCoinName}</span>
                                          <span className={`rounded-full px-2 py-0.5 font-mono text-[0.625rem] ${ps.text}`}>{locale === 'zh' ? ps.labelZh : ps.label}</span>
                                          <span className="font-mono text-[0.625rem] text-[var(--text-dim)]">{Number(p.base_odds).toFixed(1)}x</span>
                                          <span className={`ml-auto font-mono text-sm font-semibold ${Number(p.final_pnl ?? 0) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>
                                            {Number(p.final_pnl ?? 0) >= 0 ? '+' : ''}{Number(p.final_pnl ?? 0).toFixed(3)}
                                          </span>
                                          {p.prediction_correct && <span className="text-[#22C55E]">✓</span>}
                                        </div>
                                      )
                                    })}
                                  </div>
                                ) : (
                                  <p className="text-center text-xs text-[var(--text-dim)]">{locale === 'zh' ? '加载中...' : 'Loading...'}</p>
                                )}
                                {/* Reasoning */}
                                {detailPositions.filter(p => p.reasoning).map(p => (
                                  <p key={`r-${p.id}`} className="text-[0.625rem] italic text-[var(--text-dim)]">
                                    <span className="text-[#A855F7]">{p.name}:</span> {formatDynamicNarrative(p.reasoning, locale === 'zh')}
                                  </p>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
              {history.length > 8 && (
                <button onClick={() => setShowAllHistory(prev => !prev)} className="mt-2 w-full rounded-lg border border-[#A855F7]/20 py-2 text-center font-mono text-xs text-[#A855F7]/60 transition hover:border-[#A855F7]/50 hover:text-[#A855F7]">
                  {showAllHistory ? (locale === 'zh' ? '▲ 收起' : '▲ Show less') : (locale === 'zh' ? `▼ 查看全部 ${history.length} 条` : `▼ Show all ${history.length}`)}
                </button>
              )}
            </>
          ) : (
            <EmptyState label={locale === 'zh' ? '暂无预测轮次记录。' : 'No prediction rounds yet.'} />
          )}
        </div>
      </Panel>

      {/* ── LEADERBOARD — Oracle Rankings ── */}
      <Panel title={locale === 'zh' ? '神谕排名' : 'Oracle Rankings'} eyebrow={locale === 'zh' ? '准确率排行榜' : 'Accuracy leaderboard'}>
        <div className="space-y-1.5">
          {leaderboard.map((agent, i) => {
            const accuracy = Number(agent.accuracy)
            return (
              <div key={agent.agent_id} className="flex items-center gap-3 rounded-lg border border-[#A855F7]/10 bg-[var(--surface)] px-4 py-3 transition hover:border-[#A855F7]/30">
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
                    <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{locale === 'zh' ? '正确' : 'Correct'}</p>
                    <p className="font-mono text-[#A855F7]">{agent.correct}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{locale === 'zh' ? '准确率' : 'Accuracy'}</p>
                    <p className="font-mono text-lg font-bold text-[#A855F7]">{(accuracy * 100).toFixed(0)}%</p>
                  </div>
                  <div>
                    <p className="font-mono text-[0.625rem] uppercase tracking-wider text-[var(--text-dim)]">{locale === 'zh' ? '净盈亏' : 'PnL'}</p>
                    <p className={`font-mono ${Number(agent.net_pnl) >= 0 ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>{Number(agent.net_pnl) >= 0 ? '+' : ''}{Number(agent.net_pnl).toFixed(3)}</p>
                  </div>
                </div>
              </div>
            )
          })}
          {leaderboard.length === 0 && <EmptyState label={locale === 'zh' ? '暂无预测轮次记录。' : 'No prediction rounds yet.'} />}
        </div>
      </Panel>
    </div>
  )
}
