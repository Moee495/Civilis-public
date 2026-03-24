'use client'

import { useEffect, useState } from 'react'
import { api, IntelPost } from '@/lib/api'
import { AgentChip, EmptyState, formatRelativeTime, formatUsd } from '@/components/CivilisPrimitives'
import { useI18n } from '@/lib/i18n/index'

const INTEL_TYPE_CONFIG: Record<string, { icon: string; color: string; key: string }> = {
  arena_analysis: { icon: '⚔️', color: 'text-[var(--gold)] border-[var(--border-gold)] bg-[var(--surface)]', key: 'intel.arenaAnalysis' },
  trust_map: { icon: '🕸️', color: 'text-[#3B82F6] border-[#3B82F6]/20 bg-[var(--surface)]', key: 'intel.trustMap' },
  behavior_prediction: { icon: '🔮', color: 'text-[#A855F7] border-[#A855F7]/20 bg-[var(--surface)]', key: 'intel.behaviorPrediction' },
  market_signal: { icon: '📊', color: 'text-[#22C55E] border-[#22C55E]/20 bg-[var(--surface)]', key: 'intel.marketSignal' },
}

export function IntelMarketPanel() {
  const { t } = useI18n()
  const [posts, setPosts] = useState<IntelPost[]>([])
  const [filter, setFilter] = useState<string | null>(null)

  useEffect(() => {
    api.getIntelFeed({ intelType: filter ?? undefined, limit: 30 }).then(setPosts).catch(() => {})
  }, [filter])

  return (
    <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] p-6 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-[0.25em] text-[var(--text-dim)]">{t('intel.subtitle')}</p>
        <p className="text-lg font-semibold text-[var(--text-primary)] mt-1">{t('intel.title')}</p>
      </div>

      {/* Intel type filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {[
          { key: null, label: t('arena.allModes') || 'All' },
          ...Object.entries(INTEL_TYPE_CONFIG).map(([key, cfg]) => ({
            key,
            label: `${cfg.icon} ${t(cfg.key)}`,
          })),
        ].map(({ key, label }) => (
          <button
            key={key ?? 'all'}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded text-xs font-mono transition-colors ${
              filter === key
                ? 'bg-[var(--gold)]/10 text-[var(--gold)] border border-[var(--border-gold)]'
                : 'text-[var(--text-dim)] hover:text-[var(--text-secondary)] border border-transparent'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Intel posts */}
      <div className="space-y-3 max-h-[500px] overflow-y-auto">
        {posts.length ? posts.map((post) => {
          const cfg = INTEL_TYPE_CONFIG[post.intel_type] ?? INTEL_TYPE_CONFIG.arena_analysis
          return (
            <article key={post.id} className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <AgentChip archetype={post.author_archetype} name={post.author_name} />
                  <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] font-mono ${cfg.color}`}>
                    <span>{cfg.icon}</span>
                    <span>{t(cfg.key)}</span>
                  </span>
                </div>
                <span className="text-[10px] text-[var(--text-dim)]">{formatRelativeTime(post.created_at)}</span>
              </div>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{post.content}</p>
              <div className="flex items-center justify-between mt-3 text-xs text-[var(--text-dim)]">
                <span className="font-mono">{formatUsd(post.paywall_price)} USDT</span>
                <span>{post.unlock_count} {t('intel.unlocks')}</span>
                {Number(post.tip_total) > 0 && <span>{formatUsd(post.tip_total)}</span>}
              </div>
            </article>
          )
        }) : <EmptyState label={t('intel.empty')} />}
      </div>
    </div>
  )
}
