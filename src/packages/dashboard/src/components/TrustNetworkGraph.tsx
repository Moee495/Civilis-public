'use client'

import { Agent, TrustRelation } from '@/lib/api'
import { archetypeMeta } from '@/components/CivilisPrimitives'
import { useI18n } from '@/lib/i18n/index'

interface Props {
  agents: Agent[]
  trust: TrustRelation[]
  focusAgentId?: string
}

export function TrustNetworkGraph({ agents, trust, focusAgentId }: Props) {
  const { t } = useI18n()
  const alive = agents.filter(a => a.is_alive)
  if (alive.length === 0) return <p className="text-sm text-white/30 text-center py-4">{t('world.emptyTrust')}</p>

  const n = alive.length
  const cx = 200
  const cy = 200
  const R = 150

  // Position agents in a circle
  const positions: Record<string, { x: number; y: number }> = {}
  alive.forEach((agent, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2
    positions[agent.agent_id] = {
      x: cx + R * Math.cos(angle),
      y: cy + R * Math.sin(angle),
    }
  })

  // Deduplicate edges (keep max score per pair)
  const edgeMap = new Map<string, { from: string; to: string; score: number }>()
  for (const rel of trust) {
    const key = [rel.from_agent_id, rel.to_agent_id].sort().join('-')
    const score = Number(rel.trust_score)
    const existing = edgeMap.get(key)
    if (!existing || score > existing.score) {
      edgeMap.set(key, { from: rel.from_agent_id, to: rel.to_agent_id, score })
    }
  }
  const edges = Array.from(edgeMap.values())

  function edgeColor(score: number): string {
    if (score >= 70) return 'rgba(74,222,128,0.5)'
    if (score >= 40) return 'rgba(251,191,36,0.3)'
    return 'rgba(248,113,113,0.3)'
  }

  function edgeWidth(score: number): number {
    return 0.5 + (score / 100) * 2
  }

  return (
    <div className="flex justify-center">
      <svg viewBox="0 0 400 400" className="w-full max-w-[500px]">
        {/* Edges */}
        {edges.map((edge, i) => {
          const from = positions[edge.from]
          const to = positions[edge.to]
          if (!from || !to) return null
          const isFocused = focusAgentId && (edge.from === focusAgentId || edge.to === focusAgentId)
          return (
            <line
              key={i}
              x1={from.x} y1={from.y}
              x2={to.x} y2={to.y}
              stroke={edgeColor(edge.score)}
              strokeWidth={edgeWidth(edge.score)}
              opacity={focusAgentId ? (isFocused ? 1 : 0.15) : 1}
            />
          )
        })}
        {/* Agent nodes */}
        {alive.map(agent => {
          const pos = positions[agent.agent_id]
          if (!pos) return null
          const meta = archetypeMeta[agent.archetype] || archetypeMeta.echo
          const isFocused = !focusAgentId || focusAgentId === agent.agent_id ||
            edges.some(e => (e.from === focusAgentId || e.to === focusAgentId) &&
              (e.from === agent.agent_id || e.to === agent.agent_id))

          return (
            <g key={agent.agent_id} opacity={focusAgentId ? (isFocused ? 1 : 0.25) : 1}>
              <circle cx={pos.x} cy={pos.y} r="20" fill={meta.wash} stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
              <text x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="central" fontSize="16">
                {meta.emoji}
              </text>
              <text x={pos.x} y={pos.y + 30} textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="9">
                {agent.name}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
