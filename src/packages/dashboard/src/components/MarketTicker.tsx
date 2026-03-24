'use client'

import { WorldEvent, WorldSignal } from '@/lib/api'
import { useI18n } from '@/lib/i18n/index'

interface Props {
  events: WorldEvent[]
  latestSignal?: WorldSignal | null
}

export function MarketTicker({ events, latestSignal }: Props) {
  const { t, locale } = useI18n()
  const zh = locale === 'zh'

  function formatRegime(regime: string | null | undefined): string {
    const labels: Record<string, [string, string]> = {
      boom: ['繁荣', 'Boom'],
      stable: ['稳定', 'Stable'],
      recession: ['衰退', 'Recession'],
      crisis: ['危机', 'Crisis'],
    }
    if (!regime) return zh ? '稳定' : 'Stable'
    const mapped = labels[regime]
    return mapped ? (zh ? mapped[0] : mapped[1]) : regime
  }

  function formatMarketEventTitle(event: WorldEvent): string {
    const labels: Record<string, [string, string]> = {
      market_update: ['市场更新', 'Market Update'],
      market_panic_real: ['市场恐慌', 'Market Panic'],
      xlayer_boom_real: ['链上繁荣', 'On-chain Boom'],
      mist_deepens_real: ['迷雾加深', 'Mist Deepens'],
    }
    const mapped = labels[event.event_type]
    return mapped ? (zh ? mapped[0] : mapped[1]) : event.title
  }

  function formatMarketEventDescription(event: WorldEvent): string {
    const labels: Record<string, [string, string]> = {
      market_update: ['最新行情已经写入世界层，后续变化会以这组价格为参考。', 'The latest market feed has been written into the world layer for downstream changes.'],
      market_panic_real: ['短时价格承压，紧张情绪会继续向后传导。', 'Short-term price stress is now feeding broader tension into the world.'],
      xlayer_boom_real: ['价格与活跃度同步抬升，繁荣会继续向后扩散。', 'Price and activity are rising together, and the boom is spreading forward.'],
      mist_deepens_real: ['可见信息减少，定价和判断节奏会随之收紧。', 'Visibility is narrowing, so pricing and decision cadence tighten with it.'],
    }
    const mapped = labels[event.event_type]
    return mapped ? (zh ? mapped[0] : mapped[1]) : event.description
  }

  // Extract latest market data from world events
  const marketEvents = events.filter(e =>
    ['market_update', 'market_panic_real', 'xlayer_boom_real', 'mist_deepens_real'].includes(e.event_type)
  )

  const latestPrices = latestSignal?.externalMarket ?? (() => {
    for (const event of marketEvents) {
      const impact = event.impact as Record<string, unknown> | null
      if (!impact) continue

      if (impact.prices) {
        const p = impact.prices as { btcPrice: number; ethPrice: number; okbPrice: number; btcChange: number; ethChange: number; okbChange: number }
        return p
      }
      if (impact.btcPrice) {
        return { btcPrice: impact.btcPrice as number, btcChange: 0, ethPrice: 0, ethChange: 0, okbPrice: 0, okbChange: 0 }
      }
    }
    return null
  })()

  // Count market-driven events by type
  const panicCount = events.filter(e => e.event_type === 'market_panic_real').length
  const boomCount = events.filter(e => e.event_type === 'xlayer_boom_real').length
  const mistCount = events.filter(e => e.event_type === 'mist_deepens_real').length
  const marketSource = latestSignal?.externalMarket?.source ?? null
  const marketProfile = latestSignal?.externalMarket?.profile ?? null

  if (!latestPrices && panicCount === 0 && boomCount === 0) {
    return (
      <div className="text-center text-sm text-[var(--text-dim)] py-4">
        {t('market.waiting')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {latestSignal && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-2 text-xs">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[var(--text-dim)]">{t('market.scope') || 'Signal scope'}</span>
            {marketSource && (
              <span className="font-mono text-[10px] text-[var(--text-dim)]">
                {marketSource === 'mock'
                  ? (zh ? `回退样本${marketProfile ? ` · ${marketProfile}` : ''}` : `Fallback sample${marketProfile ? ` · ${marketProfile}` : ''}`)
                  : (zh ? '实盘行情' : 'Live market')}
              </span>
            )}
          </div>
          <span className="font-mono text-right text-[var(--text-secondary)]">
            {formatRegime(latestSignal.worldRegime)} · {zh ? `第${latestSignal.tickNumber}轮` : `Round ${latestSignal.tickNumber}`}
          </span>
        </div>
      )}

      {/* Live prices */}
      {latestPrices && (
        <div className="grid grid-cols-3 gap-3">
          <PriceTile symbol="BTC" price={latestPrices.btcPrice} change={latestPrices.btcChange} />
          <PriceTile symbol="ETH" price={latestPrices.ethPrice} change={latestPrices.ethChange} />
          <PriceTile symbol="OKB" price={latestPrices.okbPrice} change={latestPrices.okbChange} />
        </div>
      )}

      {/* Market impact events */}
      <div className="space-y-2">
        {marketEvents.slice(0, 5).map(event => {
          let icon = '\u{1F4CA}'
          let accent = 'border-[var(--border-primary)]'
          if (event.event_type === 'market_panic_real') { icon = '\u{1F4C9}'; accent = 'border-[#E74C3C]/30' }
          if (event.event_type === 'xlayer_boom_real') { icon = '\u{1F680}'; accent = 'border-[#22C55E]/30' }
          if (event.event_type === 'mist_deepens_real') { icon = '\u{1F32B}\uFE0F'; accent = 'border-[#A855F7]/30' }

          return (
            <div key={event.id} className={`flex items-start gap-3 rounded-lg border ${accent} bg-[var(--surface)] px-3 py-2 text-sm`}>
              <span className="mt-0.5">{icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-[var(--text-secondary)] font-medium">{formatMarketEventTitle(event)}</p>
                <p className="text-[var(--text-dim)] text-xs mt-0.5 truncate">{formatMarketEventDescription(event)}</p>
              </div>
              <span className="text-[10px] text-[var(--text-dim)] font-mono shrink-0">{zh ? `第${event.tick_number}轮` : `Round ${event.tick_number}`}</span>
            </div>
          )
        })}
      </div>

      {/* Impact summary */}
      {(panicCount > 0 || boomCount > 0 || mistCount > 0) && (
        <div className="flex gap-3 text-xs">
          {panicCount > 0 && <span className="rounded border border-[#E74C3C]/20 bg-[#E74C3C]/[0.06] px-2 py-1 text-[#E74C3C]">{t('market.panics')}: {panicCount}</span>}
          {boomCount > 0 && <span className="rounded border border-[#22C55E]/20 bg-[#22C55E]/[0.06] px-2 py-1 text-[#22C55E]">{t('market.booms')}: {boomCount}</span>}
          {mistCount > 0 && <span className="rounded border border-[#A855F7]/20 bg-[#A855F7]/[0.06] px-2 py-1 text-[#A855F7]">{t('market.mists')}: {mistCount}</span>}
        </div>
      )}
    </div>
  )
}

function PriceTile({ symbol, price, change }: { symbol: string; price: number; change: number }) {
  if (!price) return null
  const isUp = change >= 0
  return (
    <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-3 text-center">
      <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-dim)]">{symbol}</p>
      <p className="mt-1 font-mono text-sm text-[var(--text-primary)]">
        ${price >= 1000 ? price.toFixed(0) : price.toFixed(2)}
      </p>
      <p className={`text-[10px] font-mono ${isUp ? 'text-[#22C55E]' : 'text-[#E74C3C]'}`}>
        {isUp ? '+' : ''}{change.toFixed(1)}%
      </p>
    </div>
  )
}
