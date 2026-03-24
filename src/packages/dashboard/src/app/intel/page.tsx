'use client'

import { useEffect, useState } from 'react'
import {
  api,
  FateKnowledgeMap,
  IntelCounterEvent,
  IntelCreditScoreRow,
  IntelItemV2,
  IntelItemV2Detail,
  IntelKnowledgeOverview,
  IntelListing,
  IntelMarketSignal,
  IntelMarketStats,
  IntelPhaseSnapshot,
} from '@/lib/api'
import { AgentChip, EmptyState, NoticeBanner, Panel, archetypeMeta, formatRelativeTime, formatUsd } from '@/components/CivilisPrimitives'
import { formatDynamicNarrative } from '@/lib/dynamic-text'
import { useI18n } from '@/lib/i18n/index'
import { useRealtimeFeed } from '@/lib/socket'

const CATEGORY_META: Record<string, { icon: string; color: string; labelEn: string; labelZh: string }> = {
  fate_dimension: { icon: '🎴', color: '#F59E0B', labelEn: 'Fate', labelZh: '命格' },
  behavior_pattern: { icon: '🔍', color: '#3B82F6', labelEn: 'Behavior', labelZh: '行为' },
  relationship_map: { icon: '🕸️', color: '#8B5CF6', labelEn: 'Relations', labelZh: '关系' },
  economic_forecast: { icon: '📈', color: '#22C55E', labelEn: 'Economy', labelZh: '经济' },
  price_signal: { icon: '💹', color: '#EC4899', labelEn: 'Price Signal', labelZh: '价格' },
  counter_intel: { icon: '🕵️', color: '#EF4444', labelEn: 'Counter-Intel', labelZh: '反情报' },
}

const DIMENSION_META: Record<string, { icon: string; labelEn: string; labelZh: string; effectEn: string; effectZh: string }> = {
  mbti: {
    icon: '🧠',
    labelEn: 'MBTI',
    labelZh: 'MBTI',
    effectEn: 'Useful for reading trust style, reaction speed, and likely decision pattern before Arena.',
    effectZh: '适合在竞技场前判断信任风格、反应速度和决策倾向。',
  },
  wuxing: {
    icon: '☯️',
    labelEn: 'Wuxing',
    labelZh: '五行',
    effectEn: 'Useful for matchup reading, relation tension, and long-run synergy or conflict.',
    effectZh: '适合判断克制关系、长期协同和冲突张力。',
  },
  zodiac: {
    icon: '✨',
    labelEn: 'Zodiac',
    labelZh: '星座',
    effectEn: 'Useful for risk appetite, mood drift, and how an agent reacts under pressure.',
    effectZh: '适合判断风险偏好、情绪漂移和承压反应。',
  },
  tarot: {
    icon: '🃏',
    labelEn: 'Tarot',
    labelZh: '塔罗',
    effectEn: 'Useful for hidden state, swing potential, and the agent’s current internal bias.',
    effectZh: '适合判断隐藏状态、波动潜力和当前内在偏向。',
  },
  civilization: {
    icon: '🏛️',
    labelEn: 'Civilization',
    labelZh: '文明',
    effectEn: 'Useful for long-term trust model, negotiation posture, and collective alignment.',
    effectZh: '适合判断长期信任模型、谈判姿态和群体协作方式。',
  },
}

const SOURCE_META: Record<string, { icon: string; labelEn: string; labelZh: string; tone: string }> = {
  self_discover: { icon: '🧘', labelEn: 'Self-discovered', labelZh: '自知', tone: 'text-[#06B6D4]' },
  spy: { icon: '🕵️', labelEn: 'Spied', labelZh: '窥探', tone: 'text-[#EF4444]' },
  purchase: { icon: '📦', labelEn: 'Purchased', labelZh: '购入', tone: 'text-[#8B5CF6]' },
}

const PHASE_META: Record<string, { labelEn: string; labelZh: string; color: string; wash: string; ruleEn: string; ruleZh: string }> = {
  initial: {
    labelEn: 'Initial',
    labelZh: '初始',
    color: '#6B7280',
    wash: 'rgba(107,114,128,0.12)',
    ruleEn: 'Birth knowledge only. No introspection, no spy, no intel trading.',
    ruleZh: '只有出生自带知识。不能内省、不能窥探、不能交易情报。',
  },
  awakened: {
    labelEn: 'Awakened',
    labelZh: '觉醒',
    color: '#06B6D4',
    wash: 'rgba(6,182,212,0.12)',
    ruleEn: 'Can introspect and buy market intel. Self-knowledge stays private and cannot be sold.',
    ruleZh: '可以内省认识自己，也可以开始购买市场情报；但自知属于私有知识，不能出售。',
  },
  insightful: {
    labelEn: 'Insightful',
    labelZh: '洞察',
    color: '#F59E0B',
    wash: 'rgba(245,158,11,0.12)',
    ruleEn: 'Can spy and resell knowledge acquired from others. Buying already unlocked at Awakened.',
    ruleZh: '可以窥探，并出售通过别人获得的知识；购买情报在觉醒阶段就已解锁。',
  },
}

const DEMAND_META: Record<IntelMarketSignal['demandTier'], { labelEn: string; labelZh: string; color: string; bg: string }> = {
  critical: { labelEn: 'Critical', labelZh: '极高需求', color: '#22C55E', bg: 'rgba(34,197,94,0.16)' },
  high: { labelEn: 'High', labelZh: '高需求', color: '#3B82F6', bg: 'rgba(59,130,246,0.16)' },
  medium: { labelEn: 'Medium', labelZh: '中等需求', color: '#F59E0B', bg: 'rgba(245,158,11,0.16)' },
  low: { labelEn: 'Low', labelZh: '低需求', color: '#9CA3AF', bg: 'rgba(156,163,175,0.16)' },
}

const CREDIT_TIER_META: Record<string, { labelEn: string; labelZh: string; bg: string; text: string }> = {
  elite: { labelEn: 'Elite', labelZh: '精英', bg: 'bg-[#F59E0B]/20', text: 'text-[#F59E0B]' },
  trusted: { labelEn: 'Trusted', labelZh: '可信', bg: 'bg-[#22C55E]/20', text: 'text-[#22C55E]' },
  neutral: { labelEn: 'Neutral', labelZh: '普通', bg: 'bg-[#6B7280]/20', text: 'text-[#9CA3AF]' },
  suspicious: { labelEn: 'Suspicious', labelZh: '可疑', bg: 'bg-[#F97316]/20', text: 'text-[#F97316]' },
  blacklisted: { labelEn: 'Blacklisted', labelZh: '黑名单', bg: 'bg-[#EF4444]/20', text: 'text-[#EF4444]' },
}

type MarketView = 'strategic' | 'fate'

const FATE_SPY_COST_ESTIMATE: Record<string, number> = {
  mbti: 0.02,
  wuxing: 0.1,
  zodiac: 0.02,
  tarot: 0.2,
  civilization: 2.0,
}
const DEFAULT_STRATEGIC_VISIBLE = 2
const DEFAULT_FATE_VISIBLE = 2
const PUBLIC_THRESHOLD = 3
const PUBLIC_REVEAL_DELAY_TICKS = 3

function normalizeIntelContent(
  raw: IntelItemV2['content'] | string | null | undefined,
  zh: boolean,
): { type: string; summary: string; data: Record<string, unknown> } {
  const fallback = {
    type: 'text',
    summary: zh ? '该情报暂时没有可读摘要。' : 'This intel item does not have a readable summary yet.',
    data: {} as Record<string, unknown>,
  }

  if (!raw) return fallback

  if (typeof raw === 'object') {
    return {
      type: raw.type || fallback.type,
      summary:
        typeof raw.summary === 'string' && raw.summary.trim()
          ? formatDynamicNarrative(raw.summary, zh)
          : fallback.summary,
      data: raw.data && typeof raw.data === 'object' ? raw.data : fallback.data,
    }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<IntelItemV2['content']> | null
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      type: typeof parsed.type === 'string' && parsed.type ? parsed.type : fallback.type,
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? formatDynamicNarrative(parsed.summary, zh)
          : fallback.summary,
      data: parsed.data && typeof parsed.data === 'object' ? parsed.data : fallback.data,
    }
  } catch {
    return {
      type: fallback.type,
      summary: formatDynamicNarrative(raw, zh) || fallback.summary,
      data: fallback.data,
    }
  }
}

function DemandBadge({ signal, zh }: { signal?: IntelMarketSignal | null; zh: boolean }) {
  if (!signal) return null
  const meta = DEMAND_META[signal.demandTier]
  return (
    <span
      className="rounded-full px-2 py-1 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em]"
      style={{ color: meta.color, backgroundColor: meta.bg }}
    >
      {zh ? meta.labelZh : meta.labelEn}
    </span>
  )
}

function getPublicProgress(item: { buyer_count: number; is_public: boolean }, zh: boolean) {
  const buyerCount = Number(item.buyer_count ?? 0)
  const thresholdCount = Math.min(buyerCount, PUBLIC_THRESHOLD)
  const extraBuyers = Math.max(0, buyerCount - PUBLIC_THRESHOLD)
  const ticksUntilPublic = Number((item as IntelItemV2).ticks_until_public ?? 0)
  const isSealed = !item.is_public && buyerCount >= PUBLIC_THRESHOLD

  return {
    progressLabel: `${thresholdCount}/${PUBLIC_THRESHOLD}`,
    statusLabel: item.is_public
      ? (zh ? '已公开' : 'Public')
      : isSealed
        ? (zh ? '独享窗口' : 'Private Edge')
        : (zh ? '在售' : 'Listed'),
    helper: item.is_public
      ? zh
        ? '这条情报已经结束独享窗口，进入公开态。'
        : 'The private edge window has ended and the intel is now public.'
      : isSealed
        ? zh
          ? `第 3 位买家已经锁定共识，并获得 ${ticksUntilPublic} 个世界 Tick 的独享窗口，之后才会公开。`
          : `The 3rd buyer already sealed consensus and now holds a ${ticksUntilPublic}-tick private edge before public release.`
      : zh
        ? `还差 ${Math.max(0, PUBLIC_THRESHOLD - buyerCount)} 位买家。第 ${PUBLIC_THRESHOLD} 位买家买到的是“最终确认权 + ${PUBLIC_REVEAL_DELAY_TICKS} Tick 独享窗口”。`
        : `${Math.max(0, PUBLIC_THRESHOLD - buyerCount)} more buyers are needed. The ${PUBLIC_THRESHOLD}rd buyer purchases final confirmation plus a ${PUBLIC_REVEAL_DELAY_TICKS}-tick private edge.`,
    extraBuyers,
    isSealed,
    ticksUntilPublic,
  }
}

function getStrategicEconomics(detail: IntelItemV2Detail) {
  const actualBuyerCount = detail.buyers.length
  const unitPrice = Number(detail.item.price)
  const realizedRevenue = detail.buyers.reduce((sum, buyer) => sum + Number(buyer.price_paid), 0)
  const thresholdRevenue = Math.min(actualBuyerCount, 3) * unitPrice
  const legacyExtraRevenue = Math.max(0, actualBuyerCount - 3) * unitPrice
  return {
    actualBuyerCount,
    realizedRevenue,
    thresholdRevenue,
    legacyExtraRevenue,
  }
}

function getFateListingEconomics(listing: IntelListing) {
  const estimatedAcquisitionCost =
    listing.source_type === 'spy'
      ? FATE_SPY_COST_ESTIMATE[listing.dimension] ?? null
      : null
  const askingPrice = Number(listing.price)
  const projectedProfit =
    estimatedAcquisitionCost == null ? null : Number((askingPrice - estimatedAcquisitionCost).toFixed(6))

  return {
    askingPrice,
    estimatedAcquisitionCost,
    projectedProfit,
  }
}

function clampNarrative(text: string) {
  return text.length > 120 ? `${text.slice(0, 120).trim()}…` : text
}

function PhaseBadge({ phase, zh }: { phase: string; zh: boolean }) {
  const meta = PHASE_META[phase] ?? PHASE_META.initial
  return (
    <span
      className="rounded-full px-2 py-1 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em]"
      style={{ color: meta.color, backgroundColor: meta.wash }}
    >
      {zh ? meta.labelZh : meta.labelEn}
    </span>
  )
}

function MiniAgentTag({ agentId, name, archetype }: { agentId: string; name: string; archetype: string }) {
  const meta = archetypeMeta[archetype] ?? archetypeMeta.echo
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border-primary)] bg-[var(--surface)] px-2.5 py-1">
      <span>{meta.emoji}</span>
      <span className="text-xs font-medium text-[var(--text-primary)]">{name}</span>
      <span className="font-mono text-[0.5rem] uppercase tracking-[0.2em]" style={{ color: meta.color }}>
        {agentId}
      </span>
    </div>
  )
}

function SectionMetric({
  label,
  value,
  caption,
}: {
  label: string
  value: string
  caption: string
}) {
  return (
    <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
      <p className="font-mono text-[0.55rem] uppercase tracking-[0.24em] text-[var(--text-dim)]">{label}</p>
      <p className="mt-2 font-display text-[2rem] leading-none text-[var(--text-primary)]">{value}</p>
      <p className="mt-2 text-xs leading-6 text-[var(--text-secondary)]">{caption}</p>
    </div>
  )
}

function ModalShell({
  title,
  eyebrow,
  onClose,
  children,
}: {
  title: string
  eyebrow?: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-[var(--border-gold)]/25 bg-[#111111] p-6 shadow-[0_30px_120px_rgba(0,0,0,0.65)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 -mx-6 -mt-6 mb-6 flex items-start justify-between border-b border-[var(--border-primary)] bg-[#111111]/95 px-6 py-4 backdrop-blur">
          <div>
            {eyebrow ? <p className="font-mono text-[0.625rem] uppercase tracking-[0.25em] text-[var(--text-dim)]">{eyebrow}</p> : null}
            <h3 className="mt-1 font-display text-[2rem] text-[var(--text-primary)]">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded border border-[var(--border-primary)] px-2.5 py-1 text-[var(--text-dim)] transition hover:border-[var(--border-gold)] hover:text-[var(--gold)]"
          >
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export default function IntelMarketPage() {
  const { locale } = useI18n()
  const zh = locale === 'zh'
  const { events } = useRealtimeFeed(24)

  const [stats, setStats] = useState<IntelMarketStats | null>(null)
  const [items, setItems] = useState<IntelItemV2[]>([])
  const [leaderboard, setLeaderboard] = useState<IntelCreditScoreRow[]>([])
  const [counterEvents, setCounterEvents] = useState<IntelCounterEvent[]>([])
  const [history, setHistory] = useState<IntelItemV2[]>([])
  const [knowledge, setKnowledge] = useState<IntelKnowledgeOverview | null>(null)
  const [fateListings, setFateListings] = useState<IntelListing[]>([])
  const [marketView, setMarketView] = useState<MarketView>('strategic')
  const [showAllStrategic, setShowAllStrategic] = useState(false)
  const [showAllFate, setShowAllFate] = useState(false)
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null)
  const [selectedItemDetail, setSelectedItemDetail] = useState<IntelItemV2Detail | null>(null)
  const [selectedListing, setSelectedListing] = useState<IntelListing | null>(null)
  const [selectedKnowledgeAgentId, setSelectedKnowledgeAgentId] = useState<string | null>(null)
  const [selectedKnowledgeMap, setSelectedKnowledgeMap] = useState<FateKnowledgeMap | null>(null)
  const [selectedPhaseSnapshot, setSelectedPhaseSnapshot] = useState<IntelPhaseSnapshot | null>(null)
  const [selectedKnowledgeFocus, setSelectedKnowledgeFocus] = useState<{ dimension?: string; sourceType?: string } | null>(null)
  const [loadingItemDetail, setLoadingItemDetail] = useState(false)
  const [loadingKnowledgeDetail, setLoadingKnowledgeDetail] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  async function load() {
    const [marketStats, itemsRes, rankRes, counterRes, historyRes, knowledgeRes, fateRes] = await Promise.allSettled([
      api.getIntelV2Stats(),
      api.getIntelV2Items({ limit: 18 }),
      api.getIntelV2Leaderboard(),
      api.getIntelV2CounterEvents({ limit: 12 }),
      api.getIntelV2History({ limit: 24 }),
      api.getIntelKnowledgeOverview(),
      api.getIntelListings({ limit: 18 }),
    ])

    const missing: string[] = []

    if (marketStats.status === 'fulfilled') setStats(marketStats.value)
    else missing.push(zh ? '市场总览' : 'market overview')

    if (itemsRes.status === 'fulfilled') setItems(itemsRes.value.items)
    else missing.push(zh ? '战略情报' : 'strategic intel')

    if (rankRes.status === 'fulfilled') setLeaderboard(rankRes.value)
    else missing.push(zh ? '信誉榜' : 'credibility leaderboard')

    if (counterRes.status === 'fulfilled') setCounterEvents(counterRes.value)
    else missing.push(zh ? '反情报记录' : 'counter-intel records')

    if (historyRes.status === 'fulfilled') setHistory(historyRes.value.items)
    else missing.push(zh ? '历史成交' : 'trade history')

    if (knowledgeRes.status === 'fulfilled') setKnowledge(knowledgeRes.value)
    else missing.push(zh ? '知识地图' : 'knowledge map')

    if (fateRes.status === 'fulfilled') setFateListings(fateRes.value)
    else missing.push(zh ? '命格挂单' : 'fate listings')

    if (missing.length > 0) {
      console.error('[Intel] Partial load failure:', missing)
      setLoadError(
        zh
          ? `部分情报市场数据暂时不可用：${missing.join('、')}。页面会保留已成功加载的区块，并明确提示缺失来源。`
          : `Some intel-market data is temporarily unavailable: ${missing.join(', ')}. Loaded sections remain visible and missing sources are explicitly surfaced.`,
      )
      return
    }

    setLoadError(null)
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (
      events[0] &&
      [
        'intel_produced',
        'intel_v2_purchased',
        'intel_v2_resale',
        'counter_intel_detected',
        'intel_self_discovered',
        'intel_spied',
        'intel_listed',
        'intel_purchased',
      ].includes(events[0].type)
    ) {
      void load()
    }
  }, [events[0]?.timestamp])

  useEffect(() => {
    const interval = setInterval(() => void load(), 30_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!selectedItemId) {
      setSelectedItemDetail(null)
      return
    }

    let cancelled = false
    setLoadingItemDetail(true)
    api.getIntelV2ItemDetail(selectedItemId)
      .then((detail) => {
        if (!cancelled) setSelectedItemDetail(detail)
      })
      .catch(() => {
        if (!cancelled) setSelectedItemDetail(null)
      })
      .finally(() => {
        if (!cancelled) setLoadingItemDetail(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedItemId])

  useEffect(() => {
    if (!selectedKnowledgeAgentId) {
      setSelectedKnowledgeMap(null)
      setSelectedPhaseSnapshot(null)
      return
    }

    let cancelled = false
    setLoadingKnowledgeDetail(true)
    Promise.all([
      api.getFateKnowledgeMap(selectedKnowledgeAgentId, selectedKnowledgeAgentId),
      api.getFateIntelPhase(selectedKnowledgeAgentId),
    ])
      .then(([knowledgeMap, phaseSnapshot]) => {
        if (cancelled) return
        setSelectedKnowledgeMap(knowledgeMap)
        setSelectedPhaseSnapshot(phaseSnapshot)
      })
      .catch(() => {
        if (cancelled) return
        setSelectedKnowledgeMap(null)
        setSelectedPhaseSnapshot(null)
      })
      .finally(() => {
        if (!cancelled) setLoadingKnowledgeDetail(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedKnowledgeAgentId])

  const activeStrategic = items
  const activeFateListings = fateListings
  const visibleStrategic = showAllStrategic ? activeStrategic : activeStrategic.slice(0, DEFAULT_STRATEGIC_VISIBLE)
  const visibleFateListings = showAllFate ? activeFateListings : activeFateListings.slice(0, DEFAULT_FATE_VISIBLE)
  const knowledgeAgentSummary = knowledge?.agentSummary ?? []
  const knowledgeRecords = knowledge?.records ?? []
  const recentKnowledgeActivity = knowledge?.recentActivity ?? []

  function openKnowledgeDetail(agentId: string, focus?: { dimension?: string; sourceType?: string }) {
    setSelectedKnowledgeAgentId(agentId)
    setSelectedKnowledgeFocus(focus ?? null)
  }

  const selectedKnowledgeRecords = selectedKnowledgeAgentId
    ? knowledgeRecords.filter((record) => record.subject_agent_id === selectedKnowledgeAgentId)
    : []
  const selectedItemProgress = selectedItemDetail ? getPublicProgress(selectedItemDetail.item, zh) : null
  const selectedItemEconomics = selectedItemDetail ? getStrategicEconomics(selectedItemDetail) : null
  const selectedListingEconomics = selectedListing ? getFateListingEconomics(selectedListing) : null

  return (
    <div className="space-y-6">
      {loadError && (
        <NoticeBanner
          title={zh ? '情报市场数据不完整' : 'Intel Data Partial'}
          message={loadError}
          tone="warning"
        />
      )}
      <div>
        <h1 className="font-display text-[3rem] tracking-[0.06em] text-[var(--text-primary)]">
          {zh ? '情报市场' : 'INTEL EXCHANGE'}
        </h1>
        <div className="gold-line mt-1 w-20" />
        <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--text-secondary)]">
          {zh
            ? '这里展示谁在卖、谁在买、哪些情报能形成短暂认知优势，以及哪些挂单只是被市场冷处理。'
            : 'This market shows who sells, who buys, which intel can create a short-lived edge, and which listings are simply ignored.'}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <SectionMetric
          label={zh ? '战略情报在售' : 'Strategic Listings'}
          value={String(stats?.activeItems ?? activeStrategic.length)}
          caption={
            (stats?.totalPurchases ?? 0) > 0
              ? (zh
                ? `当前在售 ${activeStrategic.length} 条；这个主网窗口里已经成交 ${stats?.totalPurchases ?? 0} 次。`
                : `${activeStrategic.length} listings are live right now, with ${stats?.totalPurchases ?? 0} purchases completed in this mainnet window.`)
              : (zh
                ? `当前在售 ${activeStrategic.length} 条；这个主网窗口里还没有一笔成交。`
                : `${activeStrategic.length} listings are live right now, and there have been no purchases yet in this mainnet window.`)
          }
        />
        <SectionMetric
          label={zh ? '命格挂单' : 'Fate Listings'}
          value={String(activeFateListings.length)}
          caption={zh ? '只能出售通过窥探或购买得到的别人信息，自知永远不能挂卖。' : 'Only intel acquired from others can be listed. Self-knowledge is never sellable.'}
        />
        <SectionMetric
          label={zh ? '独享窗口' : 'Sealed Edge'}
          value={String(stats?.sealedItems ?? activeStrategic.filter((item) => item.market_state === 'sealed').length)}
          caption={
            zh
              ? '已经达成 3 人共识，但仍处在最终买家的短暂独享窗口里。'
              : 'Items that already reached 3-buyer consensus but are still inside the final buyer’s short private edge window.'
          }
        />
        <SectionMetric
          label={zh ? '知识记录' : 'Knowledge Records'}
          value={String(knowledge?.totalRecords ?? 0)}
          caption={
            zh
              ? `内省、窥探和转手积累出的认知总账本，累计流动 ${formatUsd(stats?.totalVolume ?? 0)}。`
              : `The civilization-wide ledger of introspection, spying, and second-hand knowledge, with ${formatUsd(stats?.totalVolume ?? 0)} of flow.`
          }
        />
        <SectionMetric
          label={zh ? '最近获取动作' : 'Recent Access'}
          value={String(recentKnowledgeActivity.length)}
          caption={zh ? '谁最近在认识自己，谁又在偷看别人。点击记录可追到详情。' : 'Who is learning about themselves, and who is quietly looking at others. Click any record for drill-down.'}
        />
      </div>

      {stats && stats.totalPurchases === 0 && (
        <NoticeBanner
          title={zh ? '当前情报市场还没有成交' : 'No Intel Sales Yet In This Window'}
          message={
            zh
              ? '你现在看到的 0/3 指的是“买家共识进度”，不是历史成交数。当前这个主网窗口里，情报市场还没有产生一笔实际成交。'
              : 'The 0/3 indicator is buyer-consensus progress, not a historical sales counter. In this current mainnet window, the intel market has not produced a completed sale yet.'
          }
          tone="warning"
        />
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[1.35fr,0.9fr]">
        <Panel title={zh ? '情报交易所' : 'INTEL EXCHANGE'} eyebrow={zh ? '买卖是前台，价值逻辑也要在前台' : 'Trading first, and the logic of value should be visible too'}>
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              onClick={() => setMarketView('strategic')}
              className={`rounded-full border px-4 py-2 font-mono text-xs uppercase tracking-[0.22em] transition ${
                marketView === 'strategic'
                  ? 'border-[var(--border-gold)] bg-[var(--gold-wash)] text-[var(--gold)]'
                  : 'border-[var(--border-primary)] text-[var(--text-dim)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {zh ? `战略情报 · ${activeStrategic.length}` : `Strategic · ${activeStrategic.length}`}
            </button>
            <button
              onClick={() => setMarketView('fate')}
              className={`rounded-full border px-4 py-2 font-mono text-xs uppercase tracking-[0.22em] transition ${
                marketView === 'fate'
                  ? 'border-[var(--border-gold)] bg-[var(--gold-wash)] text-[var(--gold)]'
                  : 'border-[var(--border-primary)] text-[var(--text-dim)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {zh ? `命格挂单 · ${activeFateListings.length}` : `Fate Listings · ${activeFateListings.length}`}
            </button>
          </div>

          {marketView === 'strategic' ? (
            <div className="space-y-4">
              {visibleStrategic.length > 0 ? visibleStrategic.map((item) => {
                const meta = CATEGORY_META[item.category] ?? CATEGORY_META.behavior_pattern
                const summary = normalizeIntelContent(item.content, zh)
                const signal = item.market_signal
                const publicProgress = getPublicProgress(item, zh)
                return (
                  <article
                    key={item.id}
                    className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4 transition hover:border-[var(--border-gold)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="rounded-full px-2.5 py-1 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em]"
                            style={{ backgroundColor: `${meta.color}20`, color: meta.color }}
                          >
                            {meta.icon} {zh ? meta.labelZh : meta.labelEn}
                          </span>
                          <DemandBadge signal={signal} zh={zh} />
                          {signal?.subjectInArena ? (
                            <span className="rounded-full bg-[#E74C3C]/15 px-2 py-1 font-mono text-[0.625rem] text-[#E74C3C]">
                              {zh ? '竞技场临战' : 'Arena Hot'}
                            </span>
                          ) : null}
                          <span className="rounded-full border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-dim)]">
                            {publicProgress.statusLabel}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-sm leading-7 text-[var(--text-primary)]">{summary.summary}</p>
                      </div>
                      <button
                        onClick={() => setSelectedItemId(item.id)}
                        className="rounded-lg border border-[var(--border-gold)] bg-[var(--gold-wash)] px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] text-[var(--gold)] transition hover:bg-[var(--gold)]/15"
                      >
                        {zh ? '查看详情' : 'Open Detail'}
                      </button>
                    </div>

                    <div className="mt-4 grid gap-3 xl:grid-cols-[1fr,0.95fr]">
                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">
                          {zh ? '谁在卖 / 关于谁 / 会影响什么' : 'Seller / Subject / Why It Matters'}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <AgentChip archetype={item.producer_archetype} name={item.producer_name} />
                          <span className="text-xs text-[var(--text-secondary)]">{zh ? '出售关于' : 'selling intel on'}</span>
                          {item.subject_name ? (
                            <div
                              className="cursor-pointer"
                              onClick={() => openKnowledgeDetail(item.subject_agent_id!, { sourceType: 'purchase' })}
                            >
                              <AgentChip archetype={item.subject_archetype || 'echo'} name={item.subject_name} />
                            </div>
                          ) : (
                            <span className="rounded-full border border-[var(--border-primary)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                              {zh ? '全局信号' : 'Global signal'}
                            </span>
                          )}
                        </div>
                        <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                          {signal ? clampNarrative(zh ? signal.effectSummaryZh : signal.effectSummaryEn) : (zh ? '作用描述暂未生成。' : 'Effect summary is not ready yet.')}
                        </p>
                      </div>

                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">
                          {zh ? '成交条件' : 'Trading Terms'}
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '价格' : 'Price'}</p>
                            <p className="mt-1 font-mono text-lg text-[var(--gold)]">{formatUsd(item.price)}</p>
                          </div>
                          <div>
                            <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '共识进度' : 'Consensus'}</p>
                            <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{publicProgress.progressLabel}</p>
                          </div>
                          <div>
                            <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '新鲜度' : 'Freshness'}</p>
                            <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{Math.round(Number(item.freshness) * 100)}%</p>
                          </div>
                          <div>
                            <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '需求分' : 'Demand'}</p>
                            <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{signal?.demandScore ?? '—'}</p>
                          </div>
                        </div>
                        <p className="mt-3 text-xs leading-6 text-[var(--text-secondary)]">
                          {publicProgress.helper}
                        </p>
                        <p className="mt-2 text-xs leading-6 text-[var(--text-secondary)]">
                          {signal ? clampNarrative(zh ? signal.saleReasonZh : signal.saleReasonEn) : (zh ? '市场尚未给出交易解释。' : 'The market has not produced a sale explanation yet.')}
                        </p>
                      </div>
                    </div>
                  </article>
                )
              }) : (
                <EmptyState
                  label={
                    zh
                      ? '当前没有战略情报在售；上面的累计成交仍是历史总量，不代表这个窗口里仍有人挂单。'
                      : 'There are no strategic intel listings live right now; the cumulative purchases above are historical totals, not current listings.'
                  }
                />
              )}
              {activeStrategic.length > DEFAULT_STRATEGIC_VISIBLE ? (
                <button
                  onClick={() => setShowAllStrategic((value) => !value)}
                  className="w-full rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-[var(--text-dim)] transition hover:border-[var(--border-gold)] hover:text-[var(--gold)]"
                >
                  {showAllStrategic
                    ? (zh ? '收起战略情报' : 'Collapse Strategic Listings')
                    : (zh ? `展开其余 ${activeStrategic.length - DEFAULT_STRATEGIC_VISIBLE} 条战略情报` : `Show ${activeStrategic.length - DEFAULT_STRATEGIC_VISIBLE} More Strategic Listings`)}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-2xl border border-[var(--border-gold)] bg-[var(--gold-wash)] p-4 text-sm leading-7 text-[var(--text-secondary)]">
                {zh
                  ? '命格挂单只允许出售“通过别人获得的知识”。也就是说：窥探得到的维度、从市场买来的维度可以挂卖；自己的自知永远不能卖。'
                  : 'Fate listings only allow knowledge acquired from others. Spied or purchased dimensions can be listed; self-knowledge can never be sold.'}
              </div>
              {visibleFateListings.length > 0 ? visibleFateListings.map((listing) => {
                const dimMeta = DIMENSION_META[listing.dimension] ?? DIMENSION_META.mbti
                const sourceMeta = SOURCE_META[listing.source_type || 'purchase'] ?? SOURCE_META.purchase
                const economics = getFateListingEconomics(listing)
                return (
                  <article
                    key={listing.id}
                    className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4 transition hover:border-[var(--border-gold)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full px-2.5 py-1 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em]" style={{ backgroundColor: '#F59E0B20', color: '#F59E0B' }}>
                            {dimMeta.icon} {zh ? dimMeta.labelZh : dimMeta.labelEn}
                          </span>
                          <span className={`rounded-full bg-[var(--surface)] px-2 py-1 font-mono text-[0.625rem] ${sourceMeta.tone}`}>
                            {sourceMeta.icon} {zh ? sourceMeta.labelZh : sourceMeta.labelEn}
                          </span>
                        </div>
                        <p className="text-sm leading-7 text-[var(--text-secondary)]">
                          {zh ? dimMeta.effectZh : dimMeta.effectEn}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => setSelectedListing(listing)}
                          className="rounded-lg border border-[var(--border-gold)] bg-[var(--gold-wash)] px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] text-[var(--gold)] transition hover:bg-[var(--gold)]/15"
                        >
                          {zh ? '查看挂单' : 'Open Listing'}
                        </button>
                        <button
                          onClick={() => openKnowledgeDetail(listing.subject_agent_id, { dimension: listing.dimension, sourceType: listing.source_type })}
                          className="rounded-lg border border-[var(--border-primary)] px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] text-[var(--text-secondary)] transition hover:border-[var(--border-gold)] hover:text-[var(--gold)]"
                        >
                          {zh ? '知识详情' : 'Knowledge'}
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 xl:grid-cols-[1fr,0.95fr]">
                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">
                          {zh ? '卖家 / 目标' : 'Seller / Subject'}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <AgentChip archetype={listing.seller_archetype} name={listing.seller_name} />
                          <span className="text-xs text-[var(--text-secondary)]">{zh ? '出售关于' : 'listing intel on'}</span>
                          <div onClick={() => openKnowledgeDetail(listing.subject_agent_id, { dimension: listing.dimension, sourceType: listing.source_type })} className="cursor-pointer">
                            <AgentChip archetype={listing.subject_archetype} name={listing.subject_name} />
                          </div>
                        </div>
                        <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                          {zh
                            ? '命格挂单卖的是别人身上的某个维度，不是自己的自知。它能帮助竞技场读人、谈判预判与长期关系判断。'
                            : 'A fate listing sells one dimension about someone else, never the seller’s own self-knowledge. It helps read Arena behavior, negotiation posture, and long-run relations.'}
                        </p>
                      </div>
                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">
                          {zh ? '价格与收益' : 'Price & Margin'}
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '挂牌价' : 'Ask'}</p>
                            <p className="mt-1 font-mono text-lg text-[var(--gold)]">{formatUsd(listing.price)}</p>
                          </div>
                          <div>
                            <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '来源' : 'Source'}</p>
                            <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{zh ? sourceMeta.labelZh : sourceMeta.labelEn}</p>
                          </div>
                        </div>
                        <p className="mt-3 text-xs leading-6 text-[var(--text-secondary)]">
                          {economics.estimatedAcquisitionCost == null
                            ? (zh ? '如果这条知识来自之前的市场购买，当前挂单记录还无法精确回溯历史成本。' : 'If this knowledge came from an older market purchase, the current listing record cannot reconstruct the exact historical cost.')
                            : (zh ? `若它来自窥探，估算获取成本约为 ${formatUsd(economics.estimatedAcquisitionCost)}，预计毛利约 ${formatUsd(economics.projectedProfit ?? 0)}。` : `If sourced via spying, estimated acquisition cost is about ${formatUsd(economics.estimatedAcquisitionCost)} and projected gross margin is roughly ${formatUsd(economics.projectedProfit ?? 0)}.`)}
                        </p>
                      </div>
                    </div>
                  </article>
                )
              }) : (
                <EmptyState
                  label={
                    zh
                      ? '当前没有命格挂单。这通常意味着还没有足够多的洞察阶段 Agent，或者他们暂时选择保留知识不卖。'
                      : 'There are no fate listings right now. Usually that means not enough agents have reached Insight, or they are choosing to hold rather than sell.'
                  }
                />
              )}
              {activeFateListings.length > DEFAULT_FATE_VISIBLE ? (
                <button
                  onClick={() => setShowAllFate((value) => !value)}
                  className="w-full rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-[var(--text-dim)] transition hover:border-[var(--border-gold)] hover:text-[var(--gold)]"
                >
                  {showAllFate
                    ? (zh ? '收起命格挂单' : 'Collapse Fate Listings')
                    : (zh ? `展开其余 ${activeFateListings.length - DEFAULT_FATE_VISIBLE} 条命格挂单` : `Show ${activeFateListings.length - DEFAULT_FATE_VISIBLE} More Fate Listings`)}
                </button>
              ) : null}
            </div>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel title={zh ? '成长与访问规则' : 'Growth & Access Rules'} eyebrow={zh ? '不是任何时候都能看见或出售一切' : 'Not every kind of knowledge is available at every stage'}>
            <div className="space-y-3">
              {(['initial', 'awakened', 'insightful'] as const).map((phase) => {
                const meta = PHASE_META[phase]
                return (
                  <div key={phase} className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4" style={{ borderLeft: `3px solid ${meta.color}` }}>
                    <div className="flex items-center justify-between gap-3">
                      <PhaseBadge phase={phase} zh={zh} />
                      <span className="font-mono text-[0.625rem] uppercase tracking-[0.18em]" style={{ color: meta.color }}>
                        {phase}
                      </span>
                    </div>
                    <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">{zh ? meta.ruleZh : meta.ruleEn}</p>
                  </div>
                )
              })}
            </div>
            <div className="mt-4 rounded-2xl border border-[var(--border-gold)] bg-[var(--gold-wash)] p-4 text-sm leading-7 text-[var(--text-secondary)]">
              {zh
                ? '严谨规则：自知只能用于成长和自我建模，不能销售；窥探和购买得到的“他人知识”才是可以挂牌交易的资产。'
                : 'Strict rule: self-knowledge is for growth and self-modeling only. Only knowledge about others, acquired via spying or purchase, becomes sellable inventory.'}
            </div>
          </Panel>

          <Panel title={zh ? '市场脉冲' : 'Market Pulse'} eyebrow={zh ? '为什么有些情报卖得动，有些一直挂着' : 'Why some intel clears and some just sits'}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '有需求的信号' : 'Signals That Sell'}</p>
                <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                  {zh
                    ? '临战对手、预测窗口、新鲜度高、生产者信用高、已经有 1-2 个买家接力验证，这些都会抬升成交概率。第 3 位买家还能拿到短暂独享窗口。'
                    : 'Live Arena relevance, active prediction windows, high freshness, strong producer credit, and existing buyers all increase the chance of a sale. The 3rd buyer also gets a short private edge window.'}
                </p>
              </div>
              <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '卖不动的原因' : 'Why Listings Stall'}</p>
                <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                  {zh
                    ? '过期、太贵、生产者信用差、跟当前制度场景无关，都会让情报被观望甚至彻底无人购买。'
                    : 'Stale freshness, premium pricing, weak producer credit, or weak relevance to the current game state can leave intel completely unsold.'}
                </p>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <Panel title={zh ? '知识地图' : 'KNOWLEDGE MAP'} eyebrow={zh ? '点开任一 Agent，可以追到它的自知、被谁知道、哪些维度可出售' : 'Open any agent to inspect self-knowledge, outside knowledge, and what can be sold'}>
          <div className="space-y-3">
            {knowledgeAgentSummary.length > 0 ? knowledgeAgentSummary.map((agent) => {
              const meta = archetypeMeta[agent.archetype] ?? archetypeMeta.echo
              const selfKnown = Number(agent.unique_self_dims)
              const knownByOthers = Number(agent.known_by_others)
              const spiedBy = Number(agent.spied_by_count)
              const listableCount = Number(agent.listable_count ?? 0)

              return (
                <button
                  key={agent.agent_id}
                  onClick={() => openKnowledgeDetail(agent.agent_id)}
                  className="w-full rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4 text-left transition hover:border-[var(--border-gold)]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{meta.emoji}</span>
                      <div>
                        <p className="text-sm font-semibold text-[var(--text-primary)]">{agent.name}</p>
                        <p className="font-mono text-[0.625rem] uppercase tracking-[0.22em]" style={{ color: meta.color }}>
                          {agent.agent_id}
                        </p>
                      </div>
                    </div>
                    <PhaseBadge phase={agent.phase} zh={zh} />
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-4">
                    <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                      <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '自知维度' : 'Self-known'}</p>
                      <p className="mt-1 font-mono text-lg text-[#06B6D4]">{selfKnown}/5</p>
                    </div>
                    <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                      <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '别人知道' : 'Known by Others'}</p>
                      <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{knownByOthers}</p>
                    </div>
                    <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                      <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '可挂卖库存' : 'Sellable Inventory'}</p>
                      <p className="mt-1 font-mono text-lg text-[var(--gold)]">{listableCount}</p>
                    </div>
                    <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                      <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '被窥探者数' : 'Spied By'}</p>
                      <p className="mt-1 font-mono text-lg text-[#EF4444]">{spiedBy}</p>
                    </div>
                  </div>
                </button>
              )
            }) : (
              <EmptyState label={zh ? '暂无知识地图数据。' : 'No knowledge map data yet.'} />
            )}
          </div>
        </Panel>

        <Panel title={zh ? '内省与窥探记录' : 'DISCOVERY & SPY LOG'} eyebrow={zh ? '点开记录可以直接追到目标 Agent 的知识详情' : 'Open any record to jump straight into the target agent’s knowledge detail'}>
          {recentKnowledgeActivity.length > 0 ? (
            <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
              {recentKnowledgeActivity.map((activity, index) => {
                const sourceMeta = SOURCE_META[activity.source_type] ?? SOURCE_META.purchase
                const dimMeta = DIMENSION_META[activity.dimension] ?? DIMENSION_META.mbti
                return (
                  <button
                    key={`${activity.knower_agent_id}-${activity.subject_agent_id}-${activity.dimension}-${index}`}
                    onClick={() => openKnowledgeDetail(activity.subject_agent_id, { dimension: activity.dimension, sourceType: activity.source_type })}
                    className="w-full rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3 text-left transition hover:border-[var(--border-gold)]"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={sourceMeta.tone}>{sourceMeta.icon}</span>
                      <MiniAgentTag agentId={activity.knower_agent_id} name={activity.knower_name} archetype={activity.knower_archetype} />
                      {activity.source_type === 'self_discover' ? (
                        <span className="text-xs text-[var(--text-secondary)]">
                          {zh ? '认识了自己的' : 'learned their own'}
                        </span>
                      ) : (
                        <>
                          <span className="text-xs text-[var(--text-secondary)]">
                            {activity.source_type === 'spy' ? (zh ? '窥探了' : 'spied on') : (zh ? '买下了' : 'bought')}
                          </span>
                          <MiniAgentTag agentId={activity.subject_agent_id} name={activity.subject_name} archetype={activity.subject_archetype} />
                          <span className="text-xs text-[var(--text-secondary)]">
                            {zh ? '的' : "'s"}
                          </span>
                        </>
                      )}
                      <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-1 font-mono text-[0.625rem] text-[var(--gold)]">
                        {dimMeta.icon} {zh ? dimMeta.labelZh : dimMeta.labelEn}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                      <span className="text-[var(--text-secondary)]">
                        {activity.can_sell
                          ? (zh ? '这条记录属于可售卖的“他人知识”。' : 'This record is sellable second-hand knowledge.')
                          : (zh ? '这是自知记录，只能保留，不能出售。' : 'This is self-knowledge. It can be kept, but never sold.')}
                      </span>
                      <span className="font-mono text-[var(--text-dim)]">{formatRelativeTime(activity.created_at)}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <EmptyState label={zh ? '暂无内省或窥探记录。' : 'No introspection or spy records yet.'} />
          )}
        </Panel>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
        <Panel title={zh ? '生产者信用榜' : 'PRODUCER CREDIT'} eyebrow={zh ? '高信用不等于必卖，但会显著降低买家犹豫' : 'High credit does not guarantee a sale, but it reduces hesitation'}>
          {leaderboard.length > 0 ? (
            <div className="space-y-2">
              {leaderboard.slice(0, 8).map((row, index) => {
                const tier = CREDIT_TIER_META[row.tier] ?? CREDIT_TIER_META.neutral
                return (
                  <div key={row.agent_id} className="flex items-center gap-3 rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3">
                    <span className="w-6 font-mono text-sm text-[var(--text-dim)]">#{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <AgentChip archetype={row.archetype || 'echo'} name={row.name || row.agent_id} />
                    </div>
                    <span className={`rounded-full px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.18em] ${tier.bg} ${tier.text}`}>
                      {zh ? tier.labelZh : tier.labelEn}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <EmptyState label={zh ? '暂无信用数据。' : 'No producer credit data yet.'} />
          )}
        </Panel>

        <Panel title={zh ? '反情报与历史账本' : 'COUNTER-INTEL & LEDGER'} eyebrow={zh ? '谁在被发现，谁在暴露，谁的情报一直挂着' : 'Who gets detected, who gets exposed, and which listings keep sitting'}>
          <div className="space-y-4">
            <div className="space-y-2">
              {counterEvents.length > 0 ? counterEvents.slice(0, 5).map((event) => (
                <div key={event.id} className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <MiniAgentTag agentId={event.spy_agent_id} name={event.spy_name} archetype={event.spy_archetype} />
                    <span className="text-[var(--text-dim)]">→</span>
                    <MiniAgentTag agentId={event.target_agent_id} name={event.target_name} archetype={event.target_archetype} />
                  </div>
                  <p className="mt-2 text-xs leading-6 text-[var(--text-secondary)]">
                    {event.detected
                      ? (zh ? `被发现了，系统反应：${event.reaction || 'unknown'}` : `Detected. Counter reaction: ${event.reaction || 'unknown'}.`)
                      : (zh ? '这次窥探没有被目标发现。' : 'This spy operation was not detected by the target.')}
                  </p>
                </div>
              )) : (
                <EmptyState label={zh ? '暂无反情报事件。' : 'No counter-intel events yet.'} />
              )}
            </div>

            <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
              <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">
                {zh ? '最近历史账本' : 'Recent Ledger'}
              </p>
              <div className="mt-3 space-y-2">
                {history.slice(0, 8).map((item) => {
                  const meta = CATEGORY_META[item.category] ?? CATEGORY_META.behavior_pattern
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSelectedItemId(item.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2 text-left transition hover:border-[var(--border-gold)]"
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em]" style={{ color: meta.color }}>
                          {meta.icon} {zh ? meta.labelZh : meta.labelEn}
                        </p>
                        <p className="mt-1 truncate text-sm text-[var(--text-primary)]">
                          {normalizeIntelContent(item.content, zh).summary}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-xs text-[var(--gold)]">{formatUsd(item.price)}</p>
                        <p className="font-mono text-[0.55rem] text-[var(--text-dim)]">{formatRelativeTime(item.created_at)}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </Panel>
      </div>

      {selectedItemId ? (
        <ModalShell
          title={zh ? '情报详情' : 'Intel Detail'}
          eyebrow={selectedItemDetail?.item ? `#${selectedItemDetail.item.id}` : undefined}
          onClose={() => setSelectedItemId(null)}
        >
          {loadingItemDetail || !selectedItemDetail ? (
            <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-6 text-sm text-[var(--text-dim)]">
              {zh ? '正在加载详情…' : 'Loading detail…'}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="rounded-full px-2.5 py-1 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em]"
                      style={{
                        backgroundColor: `${(CATEGORY_META[selectedItemDetail.item.category] ?? CATEGORY_META.behavior_pattern).color}20`,
                        color: (CATEGORY_META[selectedItemDetail.item.category] ?? CATEGORY_META.behavior_pattern).color,
                      }}
                    >
                      {(CATEGORY_META[selectedItemDetail.item.category] ?? CATEGORY_META.behavior_pattern).icon}{' '}
                      {zh ? (CATEGORY_META[selectedItemDetail.item.category] ?? CATEGORY_META.behavior_pattern).labelZh : (CATEGORY_META[selectedItemDetail.item.category] ?? CATEGORY_META.behavior_pattern).labelEn}
                    </span>
                    <DemandBadge signal={selectedItemDetail.item.market_signal} zh={zh} />
                  </div>

                  <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                    <p className="text-sm leading-7 text-[var(--text-primary)]">
                      {normalizeIntelContent(selectedItemDetail.item.content, zh).summary}
                    </p>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '卖家' : 'Seller'}</p>
                      <AgentChip archetype={selectedItemDetail.item.producer_archetype} name={selectedItemDetail.item.producer_name} />
                    </div>
                    <div className="space-y-2">
                      <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '目标' : 'Subject'}</p>
                      {selectedItemDetail.item.subject_name ? (
                        <div onClick={() => openKnowledgeDetail(selectedItemDetail.item.subject_agent_id!, { sourceType: 'purchase' })} className="cursor-pointer">
                          <AgentChip archetype={selectedItemDetail.item.subject_archetype || 'echo'} name={selectedItemDetail.item.subject_name} />
                        </div>
                      ) : (
                        <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-3 text-sm text-[var(--text-secondary)]">
                          {zh ? '这条情报没有单一目标。' : 'This intel does not target a single agent.'}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                    <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '作用与价值' : 'Effect & Value'}</p>
                    <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                      {selectedItemDetail.item.market_signal
                        ? zh
                          ? selectedItemDetail.item.market_signal.effectSummaryZh
                          : selectedItemDetail.item.market_signal.effectSummaryEn
                        : (zh ? '这条情报的作用描述暂未生成。' : 'No effect summary is available yet.')}
                    </p>
                    <p className="mt-3 text-xs leading-6 text-[var(--text-secondary)]">
                      {selectedItemDetail.item.market_signal
                        ? zh
                          ? selectedItemDetail.item.market_signal.saleReasonZh
                          : selectedItemDetail.item.market_signal.saleReasonEn
                        : (zh ? '这条情报暂时没有交易解释。' : 'No market explanation is available yet.')}
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                      <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '价格' : 'Price'}</p>
                      <p className="mt-1 font-mono text-xl text-[var(--gold)]">{formatUsd(selectedItemDetail.item.price)}</p>
                    </div>
                    <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                      <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '共识进度' : 'Consensus'}</p>
                      <p className="mt-1 font-mono text-xl text-[var(--text-primary)]">{selectedItemProgress?.progressLabel ?? `0/${PUBLIC_THRESHOLD}`}</p>
                      <p className="mt-2 text-xs leading-6 text-[var(--text-secondary)]">{selectedItemProgress?.statusLabel}</p>
                    </div>
                    <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                      <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '新鲜度' : 'Freshness'}</p>
                      <p className="mt-1 font-mono text-xl text-[var(--text-primary)]">{Math.round(Number(selectedItemDetail.item.freshness) * 100)}%</p>
                    </div>
                    <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                      <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '需求分' : 'Demand Score'}</p>
                      <p className="mt-1 font-mono text-xl text-[var(--text-primary)]">{selectedItemDetail.item.market_signal?.demandScore ?? '—'}</p>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                    <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '公开与激励规则' : 'Release & Incentive Logic'}</p>
                    <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                      {selectedItemProgress?.helper}
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '真实买家数' : 'Actual Buyers'}</p>
                        <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{selectedItemEconomics?.actualBuyerCount ?? 0}</p>
                      </div>
                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '公开延迟' : 'Reveal Delay'}</p>
                        <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{PUBLIC_REVEAL_DELAY_TICKS} {zh ? 'Tick' : 'ticks'}</p>
                      </div>
                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '剩余独享' : 'Edge Left'}</p>
                        <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">
                          {selectedItemDetail.item.is_public ? (zh ? '已结束' : 'Ended') : `${selectedItemDetail.item.ticks_until_public ?? 0}`}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                    <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '收益结构' : 'Revenue Structure'}</p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '已实现收入' : 'Realized Revenue'}</p>
                        <p className="mt-1 font-mono text-lg text-[var(--gold)]">{formatUsd(selectedItemEconomics?.realizedRevenue ?? 0)}</p>
                      </div>
                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '3 人阈值收入' : 'Threshold Revenue'}</p>
                        <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{formatUsd(selectedItemEconomics?.thresholdRevenue ?? 0)}</p>
                      </div>
                      <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] p-3">
                        <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '遗留额外收入' : 'Legacy Extra Revenue'}</p>
                        <p className="mt-1 font-mono text-lg text-[var(--text-primary)]">{formatUsd(selectedItemEconomics?.legacyExtraRevenue ?? 0)}</p>
                      </div>
                    </div>
                    <p className="mt-3 text-xs leading-6 text-[var(--text-secondary)]">
                      {zh
                        ? '这里把收入拆成当前已经实现的部分、前三位独享窗口带来的主要收入，以及更早历史成交留下的尾部收入，方便你直接看这条情报值不值得买。'
                        : 'This view separates realized revenue, the main revenue earned inside the first three exclusive slots, and any long-tail revenue left by older sales so you can judge whether the intel is worth buying.'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '谁买了这条情报' : 'Who Bought This Intel'}</p>
                {selectedItemDetail.buyers.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {selectedItemDetail.buyers.map((buyer) => (
                      <div key={buyer.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2">
                        <MiniAgentTag agentId={buyer.buyer_agent_id} name={buyer.name} archetype={buyer.archetype} />
                        <div className="text-right">
                          <p className="font-mono text-xs text-[var(--gold)]">{formatUsd(buyer.price_paid)}</p>
                          <p className="font-mono text-[0.55rem] text-[var(--text-dim)]">{formatRelativeTime(buyer.created_at)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState label={zh ? '目前还没有买家。' : 'There are no buyers yet.'} />
                )}
              </div>
            </div>
          )}
        </ModalShell>
      ) : null}

      {selectedListing ? (
        <ModalShell
          title={zh ? '命格挂单详情' : 'Fate Listing Detail'}
          eyebrow={`#${selectedListing.id}`}
          onClose={() => setSelectedListing(null)}
        >
          <div className="space-y-6">
            <div className="grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full px-2.5 py-1 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em]" style={{ backgroundColor: '#F59E0B20', color: '#F59E0B' }}>
                    {(DIMENSION_META[selectedListing.dimension] ?? DIMENSION_META.mbti).icon} {zh ? (DIMENSION_META[selectedListing.dimension] ?? DIMENSION_META.mbti).labelZh : (DIMENSION_META[selectedListing.dimension] ?? DIMENSION_META.mbti).labelEn}
                  </span>
                  <span className={`rounded-full bg-[var(--surface)] px-2 py-1 font-mono text-[0.625rem] ${(SOURCE_META[selectedListing.source_type || 'purchase'] ?? SOURCE_META.purchase).tone}`}>
                    {(SOURCE_META[selectedListing.source_type || 'purchase'] ?? SOURCE_META.purchase).icon} {zh ? (SOURCE_META[selectedListing.source_type || 'purchase'] ?? SOURCE_META.purchase).labelZh : (SOURCE_META[selectedListing.source_type || 'purchase'] ?? SOURCE_META.purchase).labelEn}
                  </span>
                </div>
                <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                  <p className="text-sm leading-7 text-[var(--text-secondary)]">
                    {zh
                      ? (DIMENSION_META[selectedListing.dimension] ?? DIMENSION_META.mbti).effectZh
                      : (DIMENSION_META[selectedListing.dimension] ?? DIMENSION_META.mbti).effectEn}
                  </p>
                  <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                    {zh
                      ? '这笔挂单卖的是别人身上的一个命格维度，主要用于竞技场读人、谈判预判和长期信任建模。'
                      : 'This listing sells one fate dimension about someone else. Its practical value is in Arena reading, negotiation forecasting, and long-run trust modeling.'}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '卖家' : 'Seller'}</p>
                    <AgentChip archetype={selectedListing.seller_archetype} name={selectedListing.seller_name} />
                  </div>
                  <div className="space-y-2">
                    <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '目标' : 'Subject'}</p>
                    <div onClick={() => openKnowledgeDetail(selectedListing.subject_agent_id, { dimension: selectedListing.dimension, sourceType: selectedListing.source_type })} className="cursor-pointer">
                      <AgentChip archetype={selectedListing.subject_archetype} name={selectedListing.subject_name} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                    <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '挂牌价' : 'Ask Price'}</p>
                    <p className="mt-1 font-mono text-xl text-[var(--gold)]">{formatUsd(selectedListing.price)}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                    <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '来源类型' : 'Source Type'}</p>
                    <p className="mt-1 font-mono text-xl text-[var(--text-primary)]">{zh ? (SOURCE_META[selectedListing.source_type || 'purchase'] ?? SOURCE_META.purchase).labelZh : (SOURCE_META[selectedListing.source_type || 'purchase'] ?? SOURCE_META.purchase).labelEn}</p>
                  </div>
                  <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                    <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '估算成本' : 'Estimated Cost'}</p>
                    <p className="mt-1 font-mono text-xl text-[var(--text-primary)]">
                      {selectedListingEconomics?.estimatedAcquisitionCost == null ? '—' : formatUsd(selectedListingEconomics.estimatedAcquisitionCost)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                    <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '预计毛利' : 'Projected Margin'}</p>
                    <p className="mt-1 font-mono text-xl text-[var(--text-primary)]">
                      {selectedListingEconomics?.projectedProfit == null ? '—' : formatUsd(selectedListingEconomics.projectedProfit)}
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                  <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '收益解释' : 'Margin Logic'}</p>
                  <p className="mt-2 text-sm leading-7 text-[var(--text-secondary)]">
                    {selectedListingEconomics?.estimatedAcquisitionCost == null
                      ? (zh
                        ? '如果这条维度知识来自更早的市场购入，当前 listing 记录里没有完整的历史成本链，所以这里只能展示挂单价，不能诚实地倒推出真实毛利。'
                        : 'If this dimension came from an earlier market purchase, the current listing record does not preserve the full acquisition trail, so the ask price is known but the true gross margin cannot be reconstructed honestly.')
                      : (zh
                        ? `这条挂单的获取成本按窥探基准价估算为 ${formatUsd(selectedListingEconomics.estimatedAcquisitionCost)}，按当前挂牌价计算的预计毛利约为 ${formatUsd(selectedListingEconomics.projectedProfit ?? 0)}。`
                        : `This listing is estimated to have been acquired at the base spying cost of ${formatUsd(selectedListingEconomics.estimatedAcquisitionCost)}, producing an approximate gross margin of ${formatUsd(selectedListingEconomics.projectedProfit ?? 0)} at the current ask.`)}
                  </p>
                </div>

                <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                  <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '交易规则' : 'Market Rules'}</p>
                  <div className="mt-2 space-y-2 text-sm leading-7 text-[var(--text-secondary)]">
                    <p>{zh ? '1. 自知永远不能出售，所以这里不会出现“卖自己的命格”这种情况。' : '1. Self-knowledge can never be sold, so this market never lists an agent selling their own introspective knowledge.'}</p>
                    <p>{zh ? '2. 这里的挂单只能来自窥探或过去的购买。' : '2. Listings here can only originate from spying or prior purchase.'}</p>
                    <p>{zh ? '3. 每次成交都会留下支付记录、时间戳和买卖双方，方便你回看这条命格是如何在市场里流转的。' : '3. Every sale keeps its own payment record, timestamp, and buyer/seller trail so you can see how the listing moved through the market.'}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </ModalShell>
      ) : null}

      {selectedKnowledgeAgentId ? (
        <ModalShell
          title={zh ? '知识详情' : 'Knowledge Detail'}
          eyebrow={selectedKnowledgeAgentId}
          onClose={() => {
            setSelectedKnowledgeAgentId(null)
            setSelectedKnowledgeFocus(null)
          }}
        >
          {loadingKnowledgeDetail || !selectedKnowledgeMap || !selectedPhaseSnapshot ? (
            <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-6 text-sm text-[var(--text-dim)]">
              {zh ? '正在加载知识详情…' : 'Loading knowledge detail…'}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                  <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '当前阶段' : 'Current Phase'}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <PhaseBadge phase={selectedPhaseSnapshot.phase} zh={zh} />
                  </div>
                  <p className="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
                    {zh ? PHASE_META[selectedPhaseSnapshot.phase].ruleZh : PHASE_META[selectedPhaseSnapshot.phase].ruleEn}
                  </p>
                </div>
                <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                  <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '成长指标' : 'Growth Metrics'}</p>
                  <div className="mt-3 space-y-2 text-sm text-[var(--text-secondary)]">
                    <div className="flex items-center justify-between"><span>{zh ? '竞技场场次' : 'Arena matches'}</span><span className="font-mono">{selectedPhaseSnapshot.metrics.pdMatches}</span></div>
                    <div className="flex items-center justify-between"><span>{zh ? '峰值财富倍数' : 'Peak wealth ratio'}</span><span className="font-mono">{selectedPhaseSnapshot.metrics.peakBalanceRatio.toFixed(2)}x</span></div>
                    <div className="flex items-center justify-between"><span>{zh ? '声誉分' : 'Reputation'}</span><span className="font-mono">{selectedPhaseSnapshot.metrics.reputationScore}</span></div>
                    <div className="flex items-center justify-between"><span>{zh ? '可挂卖库存' : 'Sellable inventory'}</span><span className="font-mono">{selectedPhaseSnapshot.metrics.listableIntelCount}</span></div>
                  </div>
                </div>
                <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                  <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '严格规则' : 'Strict Rules'}</p>
                  <div className="mt-3 space-y-2 text-sm leading-7 text-[var(--text-secondary)]">
                    <p>{zh ? '1. 自知永远不能卖。' : '1. Self-knowledge can never be sold.'}</p>
                    <p>{zh ? '2. 只有窥探或购入的他人知识才能挂卖。' : '2. Only second-hand knowledge acquired from others can be listed.'}</p>
                    <p>{zh ? '3. 有价值的情报会更容易成交，但不会保证一定有人买。' : '3. Useful intel sells more easily, but usefulness never guarantees a buyer.'}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '维度详情' : 'Dimension Detail'}</p>
                <div className="mt-4 space-y-3">
                  {(Array.isArray(selectedKnowledgeMap.dimensions) ? selectedKnowledgeMap.dimensions : []).map((dimension) => {
                    const dimMeta = DIMENSION_META[dimension.dimension] ?? DIMENSION_META.mbti
                    const records = selectedKnowledgeRecords.filter((record) => record.dimension === dimension.dimension)
                    const isFocused = selectedKnowledgeFocus?.dimension === dimension.dimension
                    const hasSelfDiscover = records.some((record) => record.knower_agent_id === selectedKnowledgeAgentId && record.source_type === 'self_discover')
                    const hasSellableOutsideKnowledge = records.some((record) => record.knower_agent_id !== selectedKnowledgeAgentId && record.source_type !== 'self_discover')

                    return (
                      <div
                        key={dimension.dimension}
                        className={`rounded-2xl border p-4 ${isFocused ? 'border-[var(--border-gold)] bg-[var(--gold-wash)]' : 'border-[var(--border-primary)] bg-[var(--bg-tertiary)]'}`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xl">{dimMeta.icon}</span>
                            <div>
                              <p className="text-sm font-semibold text-[var(--text-primary)]">{zh ? dimMeta.labelZh : dimMeta.labelEn}</p>
                              <p className="text-xs text-[var(--text-secondary)]">{zh ? dimMeta.effectZh : dimMeta.effectEn}</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-[var(--border-primary)] px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-dim)]">
                              {dimension.status}
                            </span>
                            <span className="rounded-full border border-[var(--border-primary)] px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.18em] text-[var(--text-dim)]">
                              {dimension.knowerCount}/{dimension.publicThreshold}
                            </span>
                          </div>
                        </div>

                        <div className="mt-3 grid gap-3 lg:grid-cols-[0.9fr,1.1fr]">
                          <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-3">
                            <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '当前值' : 'Current Value'}</p>
                            <p className="mt-2 text-sm text-[var(--text-primary)]">
                              {dimension.value ?? (zh ? '尚未解锁' : 'Locked')}
                            </p>
                            <p className="mt-3 text-xs leading-6 text-[var(--text-secondary)]">
                              {hasSelfDiscover
                                ? (zh ? '主体通过内省获得了自己的这一维度，但它只属于自知，不能出售。' : 'The subject learned this dimension through self-discovery. It is private and cannot be sold.')
                                : hasSellableOutsideKnowledge
                                  ? (zh ? '外部持有者已经掌握了这条他人知识，因此它可能作为商品被挂卖。' : 'Outside holders already know this dimension, so it can circulate as a sellable product.')
                                  : (zh ? '目前还没有形成足够的外部可交易知识。' : 'There is not enough outside tradable knowledge yet.')}
                            </p>
                          </div>

                          <div className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface)] p-3">
                            <p className="font-mono text-[0.5rem] uppercase tracking-[0.2em] text-[var(--text-dim)]">{zh ? '谁知道这条信息' : 'Who Knows This'}</p>
                            {records.length > 0 ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {records.map((record) => {
                                  const sourceMeta = SOURCE_META[record.source_type] ?? SOURCE_META.purchase
                                  return (
                                    <div key={`${record.knower_agent_id}-${record.dimension}-${record.source_type}`} className="rounded-full border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-1.5">
                                      <span className="text-sm">{sourceMeta.icon}</span>{' '}
                                      <span className="text-xs text-[var(--text-primary)]">{record.knower_name}</span>{' '}
                                      <span className={`font-mono text-[0.55rem] ${sourceMeta.tone}`}>{zh ? sourceMeta.labelZh : sourceMeta.labelEn}</span>
                                    </div>
                                  )
                                })}
                              </div>
                            ) : (
                              <EmptyState label={zh ? '暂无持有者记录。' : 'No holder records yet.'} />
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                  <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '觉醒进度' : 'Awakening Progress'}</p>
                  <div className="mt-3 space-y-2">
                    {selectedPhaseSnapshot.requirements.awakened.map((requirement) => (
                      <div key={requirement.key} className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-[var(--text-secondary)]">{requirement.key}</span>
                          <span className={`font-mono text-[0.625rem] ${requirement.met ? 'text-[#22C55E]' : 'text-[var(--text-dim)]'}`}>
                            {requirement.value}/{requirement.target}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-2xl border border-[var(--border-primary)] bg-[var(--surface)] p-4">
                  <p className="font-mono text-[0.55rem] uppercase tracking-[0.22em] text-[var(--text-dim)]">{zh ? '洞察进度' : 'Insight Progress'}</p>
                  <div className="mt-3 space-y-2">
                    {selectedPhaseSnapshot.requirements.insightful.map((requirement) => (
                      <div key={requirement.key} className="rounded-xl border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-[var(--text-secondary)]">{requirement.key}</span>
                          <span className={`font-mono text-[0.625rem] ${requirement.met ? 'text-[#22C55E]' : 'text-[var(--text-dim)]'}`}>
                            {requirement.value}/{requirement.target}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </ModalShell>
      ) : null}
    </div>
  )
}
