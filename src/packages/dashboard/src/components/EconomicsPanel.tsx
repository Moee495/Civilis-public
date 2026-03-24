'use client'

import { useMemo } from 'react'
import { ArenaMatch, X402Transaction } from '@/lib/api'
import { formatUsd } from '@/components/CivilisPrimitives'
import { useI18n } from '@/lib/i18n/index'

interface Props {
  matches: ArenaMatch[]
  transactions: X402Transaction[]
}

export function EconomicsPanel({ matches, transactions }: Props) {
  const { t } = useI18n()

  const stats = useMemo(() => {
    const settled = matches.filter(m => m.status === 'settled')

    // Entry fees collected
    const totalEntryFees = settled.length * 2 * Number(settled[0]?.entry_fee ?? 1)

    // CC subsidy: treasury pays out 0.4 per mutual cooperation
    const ccCount = settled.filter(m => m.player_a_action === 'cooperate' && m.player_b_action === 'cooperate').length
    const ccSubsidy = ccCount * 0.4

    // DD penalty: treasury collects 0.8 per mutual betrayal
    const ddCount = settled.filter(m => m.player_a_action === 'betray' && m.player_b_action === 'betray').length
    const ddPenalty = ddCount * 0.8

    // Transaction categories
    const postTxns = transactions.filter(tx => tx.tx_type === 'post')
    const tipTxns = transactions.filter(tx => tx.tx_type === 'tip')
    const arenaTxns = transactions.filter(tx => ['arena_entry', 'arena_action', 'negotiation'].includes(tx.tx_type))
    const divinationTxns = transactions.filter(tx => tx.tx_type.startsWith('divination'))

    const sumAmount = (txns: X402Transaction[]) => txns.reduce((s, tx) => s + Number(tx.amount), 0)

    return {
      totalEntryFees,
      ccSubsidy,
      ddPenalty,
      netTreasury: ddPenalty - ccSubsidy,
      ccCount,
      ddCount,
      postFees: sumAmount(postTxns),
      tipVolume: sumAmount(tipTxns),
      arenaFees: sumAmount(arenaTxns),
      divinationFees: sumAmount(divinationTxns),
      totalVolume: sumAmount(transactions),
    }
  }, [matches, transactions])

  return (
    <div className="space-y-4">
      {/* Treasury flow */}
      <div className="grid grid-cols-3 gap-3">
        <MiniStat
          label={t('economics.ccSubsidy')}
          value={`-${formatUsd(stats.ccSubsidy)}`}
          sub={`${stats.ccCount} ${t('economics.matches')}`}
          color="text-[#22C55E]"
        />
        <MiniStat
          label={t('economics.ddPenalty')}
          value={`+${formatUsd(stats.ddPenalty)}`}
          sub={`${stats.ddCount} ${t('economics.matches')}`}
          color="text-[#E74C3C]"
        />
        <MiniStat
          label={t('economics.netTreasury')}
          value={`${stats.netTreasury >= 0 ? '+' : ''}${formatUsd(stats.netTreasury)}`}
          color={stats.netTreasury >= 0 ? 'text-[var(--gold)]' : 'text-[#22C55E]'}
        />
      </div>

      {/* Fee breakdown */}
      <div className="space-y-2">
        <FeeRow label={t('economics.arenaEntry')} amount={stats.totalEntryFees} price="1.0/person" />
        <FeeRow label={t('economics.arenaAction')} amount={stats.arenaFees} price="0.005/action" />
        <FeeRow label={t('economics.postFee')} amount={stats.postFees} price="0.001/post" />
        <FeeRow label={t('economics.tipVolume')} amount={stats.tipVolume} price="0.01+" />
        <FeeRow label={t('economics.divination')} amount={stats.divinationFees} price="0.01-1.0" />
      </div>

      {/* Total volume */}
      <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3 text-center">
        <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-dim)]">{t('economics.totalVolume')}</p>
        <p className="mt-1 font-mono text-xl text-[var(--text-primary)]">{formatUsd(stats.totalVolume)}</p>
      </div>
    </div>
  )
}

function MiniStat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-3 text-center">
      <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-dim)]">{label}</p>
      <p className={`mt-1 font-mono text-lg ${color || 'text-[var(--text-primary)]'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-[var(--text-dim)]">{sub}</p>}
    </div>
  )
}

function FeeRow({ label, amount, price }: { label: string; amount: number; price: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-[var(--text-secondary)]">{label}</span>
        <span className="text-[10px] text-[var(--text-dim)] font-mono">{price}</span>
      </div>
      <span className="font-mono text-[var(--text-primary)]">{formatUsd(amount)}</span>
    </div>
  )
}
