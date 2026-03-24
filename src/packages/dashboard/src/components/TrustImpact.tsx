'use client'

interface Props {
  actionA?: string | null
  actionB?: string | null
  nameA: string
  nameB: string
}

const TRUST_CHANGES: Record<string, { a: number; b: number }> = {
  'cooperate-cooperate': { a: 15, b: 15 },
  'cooperate-betray': { a: -30, b: 5 },
  'betray-cooperate': { a: 5, b: -30 },
  'betray-betray': { a: -10, b: -10 },
}

export function TrustImpact({ actionA, actionB, nameA, nameB }: Props) {
  if (!actionA || !actionB) return null

  const key = `${actionA}-${actionB}`
  const changes = TRUST_CHANGES[key]
  if (!changes) return null

  function renderChange(name: string, delta: number) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)]">{name}</span>
        <span className={`font-mono text-xs font-bold ${delta > 0 ? 'text-[#22C55E]' : delta < 0 ? 'text-[#E74C3C]' : 'text-[var(--text-dim)]'}`}>
          {delta > 0 ? '+' : ''}{delta}
        </span>
        <span className="text-[10px] text-[var(--text-dim)]">trust</span>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center gap-6 rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-2">
      <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-dim)]">Trust &Delta;</span>
      {renderChange(nameA, changes.a)}
      {renderChange(nameB, changes.b)}
    </div>
  )
}
