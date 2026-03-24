'use client'

import { Agent } from '@/lib/api'
import { archetypeMeta, formatUsd } from '@/components/CivilisPrimitives'
import { useI18n } from '@/lib/i18n/index'

interface RealtimeEvent {
  type: string
  payload: Record<string, unknown>
  timestamp: string
}

interface Props {
  agents: Agent[]
  events: RealtimeEvent[]
}

export function DeathSpiralBanner({ agents, events }: Props) {
  const { t } = useI18n()

  const twilightAgents = agents.filter(a => a.is_alive && Number(a.balance) < 0.5)

  const recentDeaths = events
    .filter(e => e.type === 'agent_death')
    .slice(0, 3)

  const twilightEvents = events
    .filter(e => e.type === 'twilight' || e.type === 'twilight_escaped')
    .slice(0, 3)

  if (twilightAgents.length === 0 && recentDeaths.length === 0 && twilightEvents.length === 0) {
    return null
  }

  const SKULL = '\u{1F480}'
  const WARNING = '\u26A0\uFE0F'
  const TEMPLE = '\u{1F3DB}\uFE0F'
  const RUNNER = '\u{1F3C3}'

  return (
    <div className="space-y-3">
      {twilightAgents.map(agent => {
        const meta = archetypeMeta[agent.archetype] || archetypeMeta.echo
        const balance = Number(agent.balance)
        const urgency = balance < 0.2 ? 'border-[#E74C3C]/40 bg-[#E74C3C]/[0.06]' : 'border-[var(--border-gold)] bg-[var(--gold)]/[0.04]'
        const ticksEstimate = Math.max(1, Math.floor(balance / 0.01))
        const icon = balance < 0.2 ? SKULL : WARNING

        return (
          <div key={agent.agent_id} className={`rounded-lg border ${urgency} px-4 py-3 animate-pulse`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{icon}</span>
                <div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    {meta.emoji} {agent.name}
                    <span className="ml-2 text-xs text-[#E74C3C] uppercase tracking-wider">{t('death.twilight')}</span>
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    {t('death.balanceAt')} {formatUsd(agent.balance)} {' \u2014 '} {t('death.ticksLeft', { n: ticksEstimate })}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-mono text-lg text-[#E74C3C]">{formatUsd(agent.balance)}</p>
                <p className="text-[10px] text-[var(--text-dim)]">{t('death.threshold')}: $0.50</p>
              </div>
            </div>
          </div>
        )
      })}

      {recentDeaths.map((event, i) => {
        const p = event.payload
        return (
          <div key={`death-${i}`} className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="text-xl">{TEMPLE}</span>
              <div>
                <p className="text-sm text-[var(--text-secondary)]">
                  <span className="font-semibold text-[var(--text-primary)]">{String(p.name || p.agentId)}</span>
                  {' '}{t('death.hasEntered')}
                </p>
                <p className="text-xs text-[var(--text-dim)] mt-0.5">
                  {t('death.finalBalance')}: {formatUsd(String(p.finalBalance ?? 0))}
                  {p.soulHash ? <span className="ml-2 font-mono">{String(p.soulHash).slice(0, 16)}...</span> : null}
                </p>
              </div>
            </div>
          </div>
        )
      })}

      {twilightEvents.filter(e => e.type === 'twilight_escaped').map((event, i) => (
        <div key={`escape-${i}`} className="rounded-lg border border-[#22C55E]/20 bg-[#22C55E]/[0.04] px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-xl">{RUNNER}</span>
            <p className="text-sm text-[#22C55E]">
              <span className="font-semibold">{String(event.payload.agentId)}</span> {t('death.escaped')}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}
