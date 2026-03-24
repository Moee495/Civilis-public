'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n/index'
import { resolveApiBase } from '@/lib/runtime-config'
import { ProtocolBadge } from '@/components/CivilisPrimitives'

export default function ClientFooter() {
  const { t, locale } = useI18n()
  const [networkLabel, setNetworkLabel] = useState(
    locale === 'zh' ? 'X Layer · 连接中' : 'X Layer · connecting'
  )
  const protocolBadges = [
    { label: 'ERC-8183', tone: 'gold' as const },
    { label: 'ERC-8004', tone: 'violet' as const },
    { label: 'X402', tone: 'emerald' as const },
    { label: 'TEE', tone: 'sky' as const },
    { label: 'X Layer', tone: 'slate' as const },
  ]

  useEffect(() => {
    let cancelled = false

    async function loadHealth() {
      try {
        const resp = await fetch(`${resolveApiBase()}/health`)
        const data = await resp.json() as { checks?: { network?: string } }
        const network = data.checks?.network
        if (!network || cancelled) return

        const [name, chainId] = network.split(':')
        const networkName = locale === 'zh'
          ? name === 'mainnet'
            ? '主网'
            : name === 'testnet'
              ? '测试网'
              : name
          : name === 'mainnet'
            ? 'Mainnet'
            : name === 'testnet'
              ? 'Testnet'
              : name
        setNetworkLabel(locale === 'zh'
          ? `X Layer · ${networkName} ${chainId || ''}`.trim()
          : `X Layer · ${networkName} ${chainId || ''}`.trim())
      } catch {
        // Keep the safe default label if health is temporarily unavailable.
      }
    }

    void loadHealth()
    return () => { cancelled = true }
  }, [locale])

  return (
    <footer className="relative z-10 border-t border-[var(--border-primary)] bg-[var(--void)]">
      <div className="gold-line" />
      <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-3 text-center">
          <p className="font-display text-lg tracking-[0.06em] text-[var(--text-primary)]">
            CIVILIS
          </p>
          <p className="mt-1 font-mono text-[0.6875rem] uppercase tracking-[0.25em] text-[var(--text-dim)]">
            {locale === 'zh' ? 'X Layer 智能文明' : 'X Layer AI Civilization'}
          </p>
        </div>
        <p className="text-center font-mono text-[0.6875rem] text-[var(--text-dim)]">
          {t('footer.description')}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {protocolBadges.map((protocol) => (
            <ProtocolBadge key={protocol.label} label={protocol.label} tone={protocol.tone} />
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-4 font-mono text-[0.6875rem] text-[var(--text-dim)]">
          <span>{networkLabel}</span>
        </div>
        <p className="mt-4 text-center font-mono text-[0.625rem] text-[var(--text-dim)] opacity-50">
          &copy; 2026 CIVILIS
        </p>
      </div>
    </footer>
  )
}
