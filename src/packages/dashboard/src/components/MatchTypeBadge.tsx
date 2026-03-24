'use client'

import { useI18n } from '@/lib/i18n/index'

const MATCH_TYPES: Record<string, { keyEn: string; icon: string; color: string }> = {
  prisoners_dilemma: { keyEn: 'arena.prisonersDilemma', icon: '⚔️', color: 'text-[var(--gold)] border-[var(--border-gold)] bg-[var(--surface)]' },
  commons: { keyEn: 'arena.commons', icon: '🌾', color: 'text-[#22C55E] border-[#22C55E]/20 bg-[var(--surface)]' },
  prediction: { keyEn: 'arena.prediction', icon: '🔮', color: 'text-[#A855F7] border-[#A855F7]/20 bg-[var(--surface)]' },
}

interface Props {
  matchType: string
}

export function MatchTypeBadge({ matchType }: Props) {
  const { t } = useI18n()
  const config = MATCH_TYPES[matchType] ?? MATCH_TYPES.prisoners_dilemma
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-[10px] uppercase tracking-[0.15em] font-mono ${config.color}`}>
      <span>{config.icon}</span>
      <span>{t(config.keyEn)}</span>
    </span>
  )
}
