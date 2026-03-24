'use client'

import { useI18n } from '@/lib/i18n/index'

interface Props {
  matchType?: string
  actionA?: string | null
  actionB?: string | null
  nameA?: string
  nameB?: string
}

/* ─── Prisoner's Dilemma 2×2 ─── */

function PDMatrix({ actionA, actionB, nameA, nameB }: { actionA?: string | null; actionB?: string | null; nameA: string; nameB: string }) {
  const outcome = actionA && actionB ? `${actionA}-${actionB}` : null

  function cellStyle(key: string) {
    if (key !== outcome) return 'text-[var(--text-dim)]'
    if (key === 'cooperate-cooperate') return 'bg-[#22C55E]/20 text-[#22C55E] font-bold ring-1 ring-[#22C55E]/40'
    if (key === 'betray-betray') return 'bg-[var(--surface)] text-[var(--text-secondary)] font-bold ring-1 ring-[var(--border-primary)]'
    return 'bg-[#E74C3C]/15 text-[#E74C3C] font-bold ring-1 ring-[#E74C3C]/30'
  }

  return (
    <div className="grid grid-cols-3 gap-1 text-center text-xs">
      <div />
      <div className="py-2 text-[var(--text-secondary)]">{nameB} C</div>
      <div className="py-2 text-[var(--text-secondary)]">{nameB} D</div>
      <div className="py-2 text-[var(--text-secondary)]">{nameA} C</div>
      <div className={`py-2 rounded-lg transition-all ${cellStyle('cooperate-cooperate')}`}>1.2 / 1.2</div>
      <div className={`py-2 rounded-lg transition-all ${cellStyle('cooperate-betray')}`}>0.2 / 1.8</div>
      <div className="py-2 text-[var(--text-secondary)]">{nameA} D</div>
      <div className={`py-2 rounded-lg transition-all ${cellStyle('betray-cooperate')}`}>1.8 / 0.2</div>
      <div className={`py-2 rounded-lg transition-all ${cellStyle('betray-betray')}`}>0.6 / 0.6</div>
    </div>
  )
}

/* ─── Resource Grab 3×3 ─── */

const RG_ACTIONS = ['claim_low', 'claim_mid', 'claim_high'] as const
const RG_LABELS = ['Low 30%', 'Mid 50%', 'High 70%']
const RG_PAYOFFS: Record<string, string> = {
  'claim_low-claim_low': '0.60 / 0.60',
  'claim_low-claim_mid': '0.60 / 1.00',
  'claim_low-claim_high': '0.60 / 1.40',
  'claim_mid-claim_low': '1.00 / 0.60',
  'claim_mid-claim_mid': '1.00 / 1.00',
  'claim_mid-claim_high': '0.40 / 0.40',
  'claim_high-claim_low': '1.40 / 0.60',
  'claim_high-claim_mid': '0.40 / 0.40',
  'claim_high-claim_high': '0.30 / 0.30',
}

function ResourceGrabMatrix({ actionA, actionB, nameA, nameB }: { actionA?: string | null; actionB?: string | null; nameA: string; nameB: string }) {
  const outcome = actionA && actionB ? `${actionA}-${actionB}` : null

  function cellStyle(key: string) {
    if (key !== outcome) return 'text-[var(--text-dim)]'
    // No conflict (total ≤ 100%)
    const [a, b] = key.split('-')
    const pctA = a === 'claim_low' ? 0.3 : a === 'claim_mid' ? 0.5 : 0.7
    const pctB = b === 'claim_low' ? 0.3 : b === 'claim_mid' ? 0.5 : 0.7
    if (pctA + pctB <= 1.0) return 'bg-[#22C55E]/20 text-[#22C55E] font-bold ring-1 ring-[#22C55E]/40'
    if (pctA + pctB <= 1.2) return 'bg-[var(--gold)]/20 text-[var(--gold)] font-bold ring-1 ring-[var(--gold)]/40'
    return 'bg-[#E74C3C]/15 text-[#E74C3C] font-bold ring-1 ring-[#E74C3C]/30'
  }

  return (
    <div className="grid grid-cols-4 gap-1 text-center text-xs">
      <div />
      {RG_LABELS.map(l => <div key={l} className="py-2 text-[var(--text-secondary)] text-[10px]">{nameB} {l}</div>)}
      {RG_ACTIONS.map((rowAct, ri) => (
        <>
          <div key={`row-${ri}`} className="py-2 text-[var(--text-secondary)] text-[10px]">{nameA} {RG_LABELS[ri]}</div>
          {RG_ACTIONS.map((colAct) => {
            const key = `${rowAct}-${colAct}`
            return (
              <div key={key} className={`py-2 rounded-lg transition-all ${cellStyle(key)}`}>
                {RG_PAYOFFS[key]}
              </div>
            )
          })}
        </>
      ))}
    </div>
  )
}

/* ─── Info Auction 3×3 ─── */

const IA_ACTIONS = ['bid_low', 'bid_mid', 'bid_high'] as const
const IA_LABELS = ['Low 0.2', 'Mid 0.5', 'High 0.8']
const IA_PAYOFFS: Record<string, string> = {
  'bid_low-bid_low': '1.00 / 1.00',
  'bid_low-bid_mid': '0.80 / 1.20',
  'bid_low-bid_high': '0.80 / 1.20',
  'bid_mid-bid_low': '1.20 / 0.80',
  'bid_mid-bid_mid': '1.00 / 1.00',
  'bid_mid-bid_high': '0.70 / 1.30',
  'bid_high-bid_low': '1.20 / 0.80',
  'bid_high-bid_mid': '1.30 / 0.70',
  'bid_high-bid_high': '1.00 / 1.00',
}

function InfoAuctionMatrix({ actionA, actionB, nameA, nameB }: { actionA?: string | null; actionB?: string | null; nameA: string; nameB: string }) {
  const outcome = actionA && actionB ? `${actionA}-${actionB}` : null

  function cellStyle(key: string) {
    if (key !== outcome) return 'text-[var(--text-dim)]'
    const [a, b] = key.split('-')
    if (a === b) return 'bg-[var(--surface)] text-[var(--text-secondary)] font-bold ring-1 ring-[var(--border-primary)]'
    // Winner
    return 'bg-[#A855F7]/20 text-[#A855F7] font-bold ring-1 ring-[#A855F7]/40'
  }

  return (
    <div className="grid grid-cols-4 gap-1 text-center text-xs">
      <div />
      {IA_LABELS.map(l => <div key={l} className="py-2 text-[var(--text-secondary)] text-[10px]">{nameB} {l}</div>)}
      {IA_ACTIONS.map((rowAct, ri) => (
        <>
          <div key={`row-${ri}`} className="py-2 text-[var(--text-secondary)] text-[10px]">{nameA} {IA_LABELS[ri]}</div>
          {IA_ACTIONS.map((colAct) => {
            const key = `${rowAct}-${colAct}`
            return (
              <div key={key} className={`py-2 rounded-lg transition-all ${cellStyle(key)}`}>
                {IA_PAYOFFS[key]}
              </div>
            )
          })}
        </>
      ))}
    </div>
  )
}

/* ─── Public Export ─── */

export function PayoffMatrix({ matchType = 'prisoners_dilemma', actionA, actionB, nameA = 'A', nameB = 'B' }: Props) {
  const { t } = useI18n()

  return (
    <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-[var(--text-dim)] mb-3 text-center">{t('arena.payoffReference')}</p>
      {matchType === 'resource_grab' ? (
        <ResourceGrabMatrix actionA={actionA} actionB={actionB} nameA={nameA} nameB={nameB} />
      ) : matchType === 'info_auction' ? (
        <InfoAuctionMatrix actionA={actionA} actionB={actionB} nameA={nameA} nameB={nameB} />
      ) : (
        <PDMatrix actionA={actionA} actionB={actionB} nameA={nameA} nameB={nameB} />
      )}
    </div>
  )
}
