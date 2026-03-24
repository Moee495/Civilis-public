'use client'

import { useI18n } from '@/lib/i18n/index'

const STRATEGY_MAP: Record<string, {
  zhStrategy: string
  enStrategy: string
  zhTendency: string
  enTendency: string
  color: string
}> = {
  oracle: { zhStrategy: '镜像回敬', enStrategy: 'Tit-for-Tat', zhTendency: '跟随对手的最近选择', enTendency: 'Mirrors the opponent’s latest move', color: 'text-[#F97316]' },
  hawk: { zhStrategy: '强硬背叛', enStrategy: 'Always Defect', zhTendency: '约 70% 概率背叛', enTendency: 'Betrays roughly 70% of the time', color: 'text-[#E74C3C]' },
  sage: { zhStrategy: '始终合作', enStrategy: 'Always Cooperate', zhTendency: '默认 100% 合作', enTendency: 'Defaults to full cooperation', color: 'text-[#22C55E]' },
  fox: { zhStrategy: '信任条件式', enStrategy: 'Trust-Conditional', zhTendency: '信任高于 55% 时更愿意合作', enTendency: 'Cooperates once trust rises above 55%', color: 'text-[#A855F7]' },
  chaos: { zhStrategy: '随机波动', enStrategy: 'Random', zhTendency: '合作与背叛接近五五开', enTendency: 'Cooperation and betrayal stay close to 50/50', color: 'text-[#EC4899]' },
  whale: { zhStrategy: '贝叶斯下注', enStrategy: 'Bayesian', zhTendency: '判断合作概率高于 60% 时更会出手', enTendency: 'Presses harder when cooperation odds exceed 60%', color: 'text-[#3B82F6]' },
  monk: { zhStrategy: '稳定合作', enStrategy: 'Stable Coop', zhTendency: '约 75% 概率维持合作', enTendency: 'Keeps cooperation near 75%', color: 'text-[#14B8A6]' },
  echo: { zhStrategy: '镜像领跑者', enStrategy: 'Mirror Leader', zhTendency: '会模仿当前最成功者的做法', enTendency: 'Copies the current top performer', color: 'text-[#6B7280]' },
}

interface Props {
  archetype: string
}

export function AgentStrategyBadge({ archetype }: Props) {
  const { locale } = useI18n()
  const zh = locale === 'zh'
  const info = STRATEGY_MAP[archetype.toLowerCase()]
  if (!info) return null

  const strategy = zh ? info.zhStrategy : info.enStrategy
  const tendency = zh ? info.zhTendency : info.enTendency

  return (
    <div className="group relative inline-block">
      <span className={`text-[10px] tracking-[0.15em] font-mono ${info.color} cursor-help`}>
        {strategy}
      </span>
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg bg-[var(--surface)] border border-[var(--border-primary)] text-xs text-[var(--text-secondary)] whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-10">
        <p className="font-semibold text-[var(--text-primary)]">{strategy}</p>
        <p className="text-[var(--text-dim)] mt-0.5">{tendency}</p>
      </div>
    </div>
  )
}
