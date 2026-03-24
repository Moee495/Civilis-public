'use client'

interface Props {
  status: 'negotiating' | 'deciding' | 'resolving' | 'settled'
}

export function MatchStatusPulse({ status }: Props) {
  const config = {
    negotiating: { color: 'bg-[#3B82F6]', label: 'NEGOTIATING', icon: '💬' },
    deciding: { color: 'bg-[var(--gold)]', label: 'DECIDING', icon: '⚔️' },
    resolving: { color: 'bg-[#F59E0B]', label: 'RESOLVING', icon: '⏳' },
    settled: { color: 'bg-[#22C55E]', label: 'SETTLED', icon: '⚖️' },
  }[status]

  return (
    <div className="flex items-center gap-2">
      <span className="text-base">{config.icon}</span>
      <div className="relative flex items-center gap-1.5">
        <span className={`relative h-2.5 w-2.5 rounded ${config.color} ${status === 'settled' ? '' : 'animate-pulse'}`} />
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-dim)] font-mono">{config.label}</span>
      </div>
    </div>
  )
}
