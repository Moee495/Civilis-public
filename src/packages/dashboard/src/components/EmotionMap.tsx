'use client'

import { Agent, TrustRelation } from '@/lib/api'
import { archetypeMeta } from '@/components/CivilisPrimitives'
import { useI18n } from '@/lib/i18n/index'

interface Props {
  agents: Agent[]
  trust: TrustRelation[]
}

export function EmotionMap({ agents, trust }: Props) {
  const { t } = useI18n()

  // Emotion contagion: trust > 60 → risk tolerance converges
  // We show clusters of agents who influence each other
  const highTrustEdges = trust.filter(r => Number(r.trust_score) > 60)

  // Build adjacency clusters
  const clusters: string[][] = []
  const visited = new Set<string>()

  for (const edge of highTrustEdges) {
    if (visited.has(edge.from_agent_id) && visited.has(edge.to_agent_id)) continue

    const cluster: string[] = []
    const queue = [edge.from_agent_id, edge.to_agent_id]

    while (queue.length) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      cluster.push(id)

      // Find connected high-trust neighbors
      for (const e of highTrustEdges) {
        if (e.from_agent_id === id && !visited.has(e.to_agent_id)) queue.push(e.to_agent_id)
        if (e.to_agent_id === id && !visited.has(e.from_agent_id)) queue.push(e.from_agent_id)
      }
    }

    if (cluster.length >= 2) clusters.push(cluster)
  }

  // Loners (no high-trust edges)
  const allConnected = new Set(highTrustEdges.flatMap(e => [e.from_agent_id, e.to_agent_id]))
  const loners = agents.filter(a => a.is_alive && !allConnected.has(a.agent_id))

  if (agents.length === 0) {
    return <p className="text-center text-sm text-white/30 py-4">{t('emotion.empty')}</p>
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/40">{t('emotion.description')}</p>

      {/* Emotion clusters */}
      {clusters.map((cluster, i) => (
        <div key={i} className="rounded-2xl border border-blue-500/20 bg-blue-500/[0.04] px-4 py-3">
          <p className="text-[10px] uppercase tracking-[0.2em] text-blue-400/60 mb-2">
            {t('emotion.cluster')} {i + 1} — {t('emotion.synced')}
          </p>
          <div className="flex flex-wrap gap-2">
            {cluster.map(id => {
              const agent = agents.find(a => a.agent_id === id)
              if (!agent) return null
              const meta = archetypeMeta[agent.archetype] || archetypeMeta.echo
              return (
                <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/[0.06] px-3 py-1 text-xs text-white">
                  {meta.emoji} {agent.name}
                </span>
              )
            })}
          </div>
          <div className="mt-2 flex gap-1">
            {cluster.map(id => {
              const edges = highTrustEdges.filter(e =>
                (e.from_agent_id === id || e.to_agent_id === id) &&
                cluster.includes(e.from_agent_id) && cluster.includes(e.to_agent_id)
              )
              return edges.map((e, j) => (
                <span key={`${id}-${j}`} className="text-[10px] text-white/20 font-mono">
                  {e.from_agent_id.slice(0, 3)}→{e.to_agent_id.slice(0, 3)}:{e.trust_score}
                </span>
              ))
            })}
          </div>
        </div>
      ))}

      {/* Isolated agents */}
      {loners.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
          <p className="text-[10px] uppercase tracking-[0.2em] text-white/30 mb-2">{t('emotion.isolated')}</p>
          <div className="flex flex-wrap gap-2">
            {loners.map(agent => {
              const meta = archetypeMeta[agent.archetype] || archetypeMeta.echo
              return (
                <span key={agent.agent_id} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-white/50">
                  {meta.emoji} {agent.name}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Legend */}
      <p className="text-[10px] text-white/20 text-center">
        {t('emotion.legend')}
      </p>
    </div>
  )
}
