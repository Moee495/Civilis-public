'use client'

import { useI18n } from '@/lib/i18n/index'
import { describeSettlement } from '@/lib/arena-display'

interface Props {
  status: 'negotiating' | 'deciding' | 'resolving' | 'settled'
  currentRound?: number
  maxRounds?: number
  minRounds?: number
  continueProbability?: number | string | null
}

const PHASES = [
  { key: 'negotiating', label: 'NEGOTIATE', color: 'bg-[#3B82F6]' },
  { key: 'deciding', label: 'DECIDE', color: 'bg-[var(--gold)]' },
  { key: 'finalizing', label: 'SETTLED', color: 'bg-[#22C55E]' },
]

export function MatchPhaseBar({ status, currentRound, maxRounds, minRounds = 2, continueProbability }: Props) {
  const { locale } = useI18n()
  const zh = locale === 'zh'
  const currentPhase = status === 'resolving' || status === 'settled' ? 'finalizing' : status
  const currentIndex = PHASES.findIndex(p => p.key === currentPhase)
  const current = Math.max(currentRound ?? 1, 1)
  const max = Math.max(maxRounds ?? current, current)
  const continueRatio = typeof continueProbability === 'string' ? Number(continueProbability) : continueProbability ?? 0.7
  const settlePercent = Math.max(0, Math.round((1 - continueRatio) * 100))
  const guaranteedRounds = Math.min(minRounds, max || minRounds)
  const settlement = describeSettlement(current, max, locale)
  const finalLabel = status === 'resolving' ? 'SETTLING' : 'SETTLED'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 w-full">
        {PHASES.map((phase, i) => {
          const label = phase.key === 'finalizing' ? finalLabel : phase.label
          const isActive = i === currentIndex
          const isPast = i < currentIndex
          const futureClass = 'bg-[#272727] ring-1 ring-inset ring-[var(--border-primary)]/70'
          const barClass = phase.key === 'finalizing'
            ? isActive
              ? (status === 'settled'
                ? 'bg-gradient-to-r from-[#22C55E] to-[#86EFAC] ring-1 ring-[#86EFAC]/50 shadow-[0_0_14px_rgba(34,197,94,0.45)]'
                : 'bg-gradient-to-r from-[#F59E0B] to-[#FCD34D] ring-1 ring-[#FCD34D]/55 shadow-[0_0_14px_rgba(245,158,11,0.4)]')
              : isPast
                ? (status === 'settled' ? 'bg-[#22C55E]/35' : 'bg-[#F59E0B]/35')
                : futureClass
            : isActive
              ? `${phase.color} shadow-lg`
              : isPast
                ? 'bg-[var(--text-dim)]'
                : futureClass

          const labelClass = phase.key === 'finalizing'
            ? isActive
              ? (status === 'settled' ? 'text-[#8CF0A5]' : 'text-[#FCD34D]')
              : 'text-[var(--text-dim)]'
            : isActive
              ? 'text-[var(--text-secondary)]'
              : 'text-[var(--text-dim)]'

          return (
            <div key={phase.key} className="flex-1 flex flex-col items-center gap-1">
              <div className={`h-1.5 w-full rounded transition-all duration-500 ${barClass}`} />
              <span className={`text-[9px] uppercase tracking-[0.2em] ${labelClass}`}>{label}</span>
            </div>
          )
        })}
      </div>
      {max > 1 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-center gap-1.5">
            {Array.from({ length: max }, (_, i) => {
              const roundNum = i + 1
              const isSettledRound = status === 'settled'
              const isCompleted = isSettledRound ? roundNum <= current : roundNum < current
              const isCurrent = !isSettledRound && roundNum === current
              const isFinal = isSettledRound && roundNum === current
              const isFuture = roundNum > current
              const isGuaranteedFuture = isFuture && roundNum <= guaranteedRounds
              const roundClass = isFinal
                ? 'bg-[#22C55E] ring-2 ring-[#22C55E]/35 shadow-[0_0_10px_rgba(34,197,94,0.45)]'
                : isCompleted
                  ? 'bg-[#22C55E]/65'
                  : isCurrent
                    ? 'bg-[var(--gold)] ring-2 ring-[var(--gold)]/30 animate-pulse'
                    : isGuaranteedFuture
                      ? 'bg-[#3B82F6]/30'
                      : isFuture
                        ? 'border border-dashed border-[var(--border-primary)] bg-transparent opacity-70'
                        : ''

              return (
                <div
                  key={roundNum}
                  className={`h-2.5 w-2.5 rounded-full transition-all duration-300 ${roundClass}`}
                  title={`Round ${roundNum}${isCurrent ? ' (current)' : ''}${isFinal ? ' (final)' : ''}${isFuture && roundNum > guaranteedRounds ? ' (?)' : ''}`}
                />
              )
            })}
          <span className="text-[10px] font-mono text-[var(--text-dim)] ml-1">
            {status === 'settled'
              ? (zh ? `终局 R${current}/${max}` : `Final R${current}/${max}`)
              : status === 'resolving'
                ? (zh ? `结算中 R${current}/${max}` : `Settling R${current}/${max}`)
              : `R${current}/${max}`}
          </span>
        </div>
          <p className="text-center font-mono text-[10px] text-[var(--text-dim)]">
            {status === 'settled'
              ? settlement.detail
              : zh
                ? `${guaranteedRounds}-${max} 轮，R${guaranteedRounds} 后每轮 ${settlePercent}% 概率终局`
                : `${guaranteedRounds}-${max} rounds, ${settlePercent}% settle chance each round after R${guaranteedRounds}`}
          </p>
        </div>
      )}
    </div>
  )
}
