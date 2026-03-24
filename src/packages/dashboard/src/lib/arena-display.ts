'use client'

import type { Locale } from '@/lib/i18n/index'

type LocaleInput = Locale | boolean

function isZh(locale: LocaleInput): boolean {
  return locale === 'zh' || locale === true
}

const ACTION_LABELS: Record<string, { zh: string; en: string; compact: string }> = {
  cooperate: { zh: '合作', en: 'COOPERATE', compact: 'C' },
  betray: { zh: '背叛', en: 'BETRAY', compact: 'D' },
  claim_low: { zh: '低索取', en: 'CLAIM LOW', compact: 'Lo' },
  claim_mid: { zh: '中索取', en: 'CLAIM MID', compact: 'Mid' },
  claim_high: { zh: '高索取', en: 'CLAIM HIGH', compact: 'Hi' },
  bid_low: { zh: '低出价', en: 'BID LOW', compact: 'Lo' },
  bid_mid: { zh: '中出价', en: 'BID MID', compact: 'Mid' },
  bid_high: { zh: '高出价', en: 'BID HIGH', compact: 'Hi' },
}

export function formatArenaActionLabel(
  action: string | null | undefined,
  locale: LocaleInput,
  compact: boolean = false,
): string {
  if (!action) return compact ? '…' : '…'

  const label = ACTION_LABELS[action]
  if (label) {
    if (compact) return label.compact
    return isZh(locale) ? label.zh : label.en
  }

  return compact ? action.slice(0, 3).toUpperCase() : action.replace(/_/g, ' ').toUpperCase()
}

export function arenaActionTone(action?: string | null): string {
  if (!action) return 'text-[var(--text-dim)]'
  if (action === 'cooperate') return 'text-[#22C55E]'
  if (action === 'betray') return 'text-[#E74C3C]'
  if (action.startsWith('claim_low')) return 'text-[#22C55E]'
  if (action.startsWith('claim_mid')) return 'text-[#3B82F6]'
  if (action.startsWith('claim_high')) return 'text-[var(--gold)]'
  if (action.startsWith('bid_mid') || action.startsWith('bid_high')) return 'text-[#A855F7]'
  return 'text-[var(--text-secondary)]'
}

export const actionTextColor = arenaActionTone

export function describeSettlement(actualRounds: number, configuredMax: number, locale: LocaleInput) {
  const zh = isZh(locale)
  const endedEarly = actualRounds < configuredMax

  if (endedEarly) {
    const skippedFrom = actualRounds + 1
    const skippedLabel = skippedFrom <= configuredMax
      ? zh
        ? `R${skippedFrom}-R${configuredMax} 未触发`
        : `R${skippedFrom}-R${configuredMax} were skipped`
      : zh
        ? '后续轮次未触发'
        : 'Later rounds were skipped'

    return {
      endedEarly,
      headline: zh ? `终局于 R${actualRounds}` : `Finalized at R${actualRounds}`,
      detail: skippedLabel,
      shortLabel: zh ? `提前终局 · R${actualRounds}` : `Ended early · R${actualRounds}`,
    }
  }

  return {
    endedEarly,
    headline: zh ? `打满 ${configuredMax} 轮` : `Reached ${configuredMax} rounds`,
    detail: zh ? '达到轮次上限后结算' : 'Settled at the round cap',
    shortLabel: zh ? '打满上限' : 'Cap reached',
  }
}

type MatchRoundLike = {
  round_number: number
  player_a_action?: string | null
  player_b_action?: string | null
  player_a_payout?: string | number | null
  player_b_payout?: string | number | null
  outcome?: string | null
}

type MatchLike = {
  match_type?: string | null
  status?: string | null
  current_round?: number | null
  total_rounds?: number | null
  max_rounds?: number | null
  negotiation_deadline?: string | null
  player_a_action?: string | null
  player_b_action?: string | null
  rounds?: MatchRoundLike[] | null
}

function getArenaRuleMinRounds(match: MatchLike): number {
  return (match.match_type ?? 'prisoners_dilemma') === 'prisoners_dilemma' ? 2 : 1
}

export function getArenaCompletedRounds(match: MatchLike): number {
  if (match.rounds?.length) return match.rounds.length
  if (match.status === 'settled') {
    return Math.max(match.total_rounds ?? match.current_round ?? 1, 1)
  }
  return Math.max((match.current_round ?? 1) - 1, 0)
}

export function getArenaDisplayRound(match: MatchLike): number {
  if (match.status === 'settled') {
    return Math.max(
      match.total_rounds ?? getArenaCompletedRounds(match),
      getArenaCompletedRounds(match),
      getArenaRuleMinRounds(match),
      1,
    )
  }
  return Math.max(match.current_round ?? getArenaCompletedRounds(match) + 1, 1)
}

export function getArenaConfiguredMaxRounds(match: MatchLike): number {
  return Math.max(
    match.max_rounds ?? getArenaDisplayRound(match),
    getArenaDisplayRound(match),
    getArenaCompletedRounds(match),
    getArenaRuleMinRounds(match),
    1,
  )
}

export function getArenaEffectiveDeadline(match: MatchLike): string | null {
  if (!match.negotiation_deadline) return null
  const baseTime = new Date(match.negotiation_deadline).getTime()
  if (!Number.isFinite(baseTime)) return null
  const extraMs = match.status === 'deciding' || match.status === 'resolving' ? 30_000 : 0
  return new Date(baseTime + extraMs).toISOString()
}

export function isArenaDeadlineExpired(match: MatchLike): boolean {
  const deadline = getArenaEffectiveDeadline(match)
  if (!deadline) return false
  return new Date(deadline).getTime() <= Date.now()
}

export function getArenaLastSettledRound(match: MatchLike): MatchRoundLike | null {
  if (!match.rounds?.length) return null
  return match.rounds[match.rounds.length - 1] ?? null
}

export function isLegacySingleRoundPDMatch(match: MatchLike): boolean {
  if ((match.match_type ?? 'prisoners_dilemma') !== 'prisoners_dilemma') {
    return false
  }

  const completed = match.rounds?.length ?? Math.max(match.total_rounds ?? match.current_round ?? 0, 0)
  return (match.status ?? 'settled') === 'settled' && completed < getArenaRuleMinRounds(match)
}
