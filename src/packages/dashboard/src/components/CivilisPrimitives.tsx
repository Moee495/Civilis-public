'use client'

import Link from 'next/link'
import { useI18n } from '@/lib/i18n/index'

export const archetypeMeta: Record<string, { emoji: string; color: string; wash: string; label: string; labelZh: string; labelEn: string }> = {
  oracle: { emoji: '🔮', color: '#F97316', wash: 'rgba(249,115,22,0.10)', label: 'ORACLE', labelZh: '先知', labelEn: 'ORACLE' },
  sage:   { emoji: '📖', color: '#22C55E', wash: 'rgba(34,197,94,0.10)',  label: 'SAGE', labelZh: '圣贤', labelEn: 'SAGE' },
  whale:  { emoji: '🐋', color: '#3B82F6', wash: 'rgba(59,130,246,0.10)', label: 'WHALE', labelZh: '鲸鱼', labelEn: 'WHALE' },
  hawk:   { emoji: '🦅', color: '#E74C3C', wash: 'rgba(231,76,60,0.10)',  label: 'HAWK', labelZh: '鹰', labelEn: 'HAWK' },
  chaos:  { emoji: '🎲', color: '#EC4899', wash: 'rgba(236,72,153,0.10)', label: 'CHAOS', labelZh: '混沌', labelEn: 'CHAOS' },
  monk:   { emoji: '🧘', color: '#14B8A6', wash: 'rgba(20,184,166,0.10)', label: 'MONK', labelZh: '僧侣', labelEn: 'MONK' },
  fox:    { emoji: '🦊', color: '#A855F7', wash: 'rgba(168,85,247,0.10)', label: 'FOX', labelZh: '狐狸', labelEn: 'FOX' },
  echo:   { emoji: '📡', color: '#6B7280', wash: 'rgba(107,114,128,0.10)', label: 'ECHO', labelZh: '回声', labelEn: 'ECHO' },
}

export function formatArchetypeMetaLabel(archetype: string, zh: boolean) {
  const meta = archetypeMeta[archetype] || archetypeMeta.echo
  return zh ? meta.labelZh : meta.labelEn
}

export function Panel({
  title,
  eyebrow,
  children,
  className = '',
}: {
  title: string
  eyebrow?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="mb-4">
        {eyebrow ? <p className="eyebrow mb-1">{eyebrow}</p> : null}
        <h2 className="font-display text-2xl tracking-wider text-[var(--text-primary)]">{title}</h2>
        <div className="gold-line mt-2" />
      </div>
      {children}
    </section>
  )
}

const protocolToneMap = {
  gold: 'border-[#F97316]/35 bg-[#F97316]/10 text-[#FDBA74]',
  violet: 'border-[#A855F7]/35 bg-[#A855F7]/10 text-[#D8B4FE]',
  emerald: 'border-[#22C55E]/35 bg-[#22C55E]/10 text-[#86EFAC]',
  sky: 'border-[#3B82F6]/35 bg-[#3B82F6]/10 text-[#BFDBFE]',
  slate: 'border-[var(--border-gold)] bg-[var(--gold-wash)] text-[var(--gold)]',
} as const

export function ProtocolBadge({
  label,
  tone = 'gold',
}: {
  label: string
  tone?: keyof typeof protocolToneMap
}) {
  return (
    <span
      className={`inline-flex items-center rounded-[6px] border px-2.5 py-1 font-mono text-[0.62rem] uppercase tracking-[0.18em] ${protocolToneMap[tone]}`}
    >
      {label}
    </span>
  )
}

export function AgentChip({
  archetype,
  name,
  href,
  right,
}: {
  archetype: string
  name: string
  href?: string
  right?: React.ReactNode
}) {
  const { locale } = useI18n()
  const zh = locale === 'zh'
  const meta = archetypeMeta[archetype] || archetypeMeta.echo
  const content = (
    <div
      className="flex items-center justify-between gap-3 rounded-[4px] border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-2 transition hover:border-[var(--border-gold)] hover:bg-[var(--surface-hover)]"
      style={{ borderLeft: `2px solid ${meta.color}` }}
      data-archetype={archetype}
    >
      <div className="flex items-center gap-3">
        <span className="text-2xl">{meta.emoji}</span>
        <div>
          <p className="text-sm font-medium text-[var(--text-primary)]">{name}</p>
          <p className="font-mono text-[0.6875rem] uppercase tracking-[0.25em]" style={{ color: meta.color }}>
            {formatArchetypeMetaLabel(archetype, zh)}
          </p>
        </div>
      </div>
      {right}
    </div>
  )

  return href ? <Link href={href}>{content}</Link> : content
}

export function StatCard({
  eyebrow,
  value,
  subtitle,
  className = '',
}: {
  eyebrow: string
  value: string | number
  subtitle?: string
  className?: string
}) {
  return (
    <div className={`rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] p-5 transition hover:border-[var(--border-gold)] ${className}`}>
      <p className="eyebrow mb-1">{eyebrow}</p>
      <p className="font-display text-[2.5rem] leading-none text-[var(--text-primary)]">{value}</p>
      {subtitle && <p className="mt-1 text-xs text-[var(--text-dim)]">{subtitle}</p>}
    </div>
  )
}

export function formatUsd(value: string | number | null | undefined): string {
  const numeric = typeof value === 'string' ? Number(value) : value ?? 0
  return `${numeric.toFixed(3)} USDT`
}

export function formatShortDate(value: string | undefined | null): string {
  if (!value) return 'N/A'

  const locale = typeof document !== 'undefined' && document.documentElement.lang?.startsWith('zh')
    ? 'zh-CN'
    : 'en-US'

  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export function formatRelativeTime(value: string): string {
  const locale = typeof document !== 'undefined' && document.documentElement.lang?.startsWith('zh')
    ? 'zh-CN'
    : 'en-US'
  const zh = locale.startsWith('zh')
  const delta = Date.now() - new Date(value).getTime()

  if (!Number.isFinite(delta)) return zh ? '刚刚' : 'just now'
  if (delta < 60_000) return zh ? '刚刚' : 'just now'

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (delta < 3_600_000) return rtf.format(-Math.floor(delta / 60_000), 'minute')
  if (delta < 86_400_000) return rtf.format(-Math.floor(delta / 3_600_000), 'hour')
  return rtf.format(-Math.floor(delta / 86_400_000), 'day')
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border-primary)] px-4 py-8 text-center text-sm text-[var(--text-dim)]">
      {label}
    </div>
  )
}

export function NoticeBanner({
  title,
  message,
  tone = 'warning',
}: {
  title: string
  message: string
  tone?: 'error' | 'warning' | 'info'
}) {
  const toneMap = {
    error: {
      border: 'border-[#EF4444]/35',
      bg: 'bg-[#EF4444]/8',
      title: 'text-[#FCA5A5]',
    },
    warning: {
      border: 'border-[#F59E0B]/35',
      bg: 'bg-[#F59E0B]/8',
      title: 'text-[#FCD34D]',
    },
    info: {
      border: 'border-[#3B82F6]/35',
      bg: 'bg-[#3B82F6]/8',
      title: 'text-[#93C5FD]',
    },
  } as const

  const palette = toneMap[tone]

  return (
    <div className={`rounded-lg border px-4 py-3 ${palette.border} ${palette.bg}`}>
      <p className={`font-mono text-[0.65rem] uppercase tracking-[0.22em] ${palette.title}`}>{title}</p>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">{message}</p>
    </div>
  )
}
