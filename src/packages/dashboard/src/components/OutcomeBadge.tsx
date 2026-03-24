'use client'

import { useI18n } from '@/lib/i18n/index'

interface Props {
  actionA: string | null | undefined
  actionB: string | null | undefined
  nameA?: string
  nameB?: string
}

export function OutcomeBadge({ actionA, actionB, nameA = 'A', nameB = 'B' }: Props) {
  const { locale } = useI18n()
  const zh = locale === 'zh'
  if (!actionA || !actionB) return <span className="text-[var(--text-dim)] text-xs font-mono">{zh ? '待定' : 'PENDING'}</span>

  const outcomes: Record<string, { label: string; emoji: string; bg: string; text: string }> = {
    'cooperate-cooperate': {
      label: zh ? '双方合作' : 'Mutual Trust',
      emoji: '🤝',
      bg: 'bg-[#22C55E]/12 border-[#22C55E]/30',
      text: 'text-[#5EEA84]',
    },
    'cooperate-betray': {
      label: zh ? `${nameB} 背叛` : `${nameB} Betrayed`,
      emoji: '🗡️',
      bg: 'bg-[#E74C3C]/12 border-[#E74C3C]/30',
      text: 'text-[#FF8E83]',
    },
    'betray-cooperate': {
      label: zh ? `${nameA} 背叛` : `${nameA} Betrayed`,
      emoji: '🗡️',
      bg: 'bg-[#E74C3C]/12 border-[#E74C3C]/30',
      text: 'text-[#FF8E83]',
    },
    'betray-betray': {
      label: zh ? '双方惩罚' : 'Mutual Loss',
      emoji: '💀',
      bg: 'bg-[var(--surface)] border-[var(--border-primary)]',
      text: 'text-[var(--text-secondary)]',
    },
  }

  const key = `${actionA}-${actionB}`
  const outcome = outcomes[key] || { label: '???', emoji: '❓', bg: 'bg-[var(--surface)] border-[var(--border-primary)]', text: 'text-[var(--text-dim)]' }

  return (
    <div className={`inline-flex items-center gap-2 rounded border px-3 py-1.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02)] ${outcome.bg}`}>
      <span>{outcome.emoji}</span>
      <span className={`text-xs font-semibold ${outcome.text}`}>{outcome.label}</span>
    </div>
  )
}
