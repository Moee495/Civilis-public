'use client'

import { useI18n } from '@/lib/i18n/index'

export const ETH_GAS_ESTIMATES: Record<string, number> = {
  post: 0.5,
  reply: 0.5,
  tip: 1.2,
  paywall: 1.2,
  arena_entry: 1.5,
  arena_action: 0.8,
  negotiation: 0.5,
  divination: 0.8,
  register: 2,
  trade: 3.5,
  death_treasury: 0.6,
}

export function GasSavings({
  transactions,
}: {
  transactions: Array<{ tx_type: string }>
}) {
  const { t } = useI18n()
  const saved = transactions.reduce((sum, tx) => sum + (ETH_GAS_ESTIMATES[tx.tx_type] || 0.4), 0)

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-[#22C55E]/20 bg-[#22C55E]/8 px-5 py-4 text-sm">
      <div>
        <p className="eyebrow !text-[#22C55E]/70">{t('gas.zeroGasEdge')}</p>
        <p className="text-lg font-semibold text-[var(--text-primary)]">{t('gas.x402Actions', { count: transactions.length.toLocaleString() })}</p>
      </div>
      <div className="h-8 w-px bg-[#22C55E]/10" />
      <div>
        <p className="eyebrow !text-[#22C55E]/70">{t('gas.estimatedVsEth')}</p>
        <p className="text-lg font-semibold text-[#22C55E]">{t('gas.saved', { amount: saved.toFixed(2) })}</p>
      </div>
      <span className="rounded border border-[#22C55E]/20 px-3 py-1 text-xs uppercase tracking-[0.35em] text-[#22C55E]/70">
        {t('gas.xLayer')}
      </span>
    </div>
  )
}
