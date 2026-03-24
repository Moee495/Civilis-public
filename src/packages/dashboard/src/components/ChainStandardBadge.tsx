'use client'

import { Agent, ArenaMatch } from '@/lib/api'
import { useI18n } from '@/lib/i18n/index'

interface Props {
  agent: Agent
  matches: ArenaMatch[]
}

export function ChainStandardBadge({ agent, matches }: Props) {
  const { t } = useI18n()

  const settledMatches = matches.filter(m => m.status === 'settled')
  const isPlayer = (m: ArenaMatch) => m.player_a_id === agent.agent_id || m.player_b_id === agent.agent_id
  const agentMatches = settledMatches.filter(isPlayer)

  return (
    <div className="space-y-3">
      {/* ERC-8004 Identity */}
      <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-mono text-[var(--gold)] bg-[var(--gold)]/10 px-2 py-0.5 rounded">ERC-8004</span>
          <span className="text-[10px] text-[var(--text-dim)]">{t('chain.agentIdentity')}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <p className="text-[var(--text-dim)]">{t('chain.tokenId')}</p>
            <p className="font-mono text-[var(--text-primary)]">{agent.erc8004_token_id ? `#${agent.erc8004_token_id}` : t('chain.pending')}</p>
          </div>
          <div>
            <p className="text-[var(--text-dim)]">{t('chain.soulGrade')}</p>
            <p className="font-mono text-[var(--text-primary)]">{agent.soul_grade || t('chain.unjudged')}</p>
          </div>
          <div>
            <p className="text-[var(--text-dim)]">{t('chain.reputation')}</p>
            <p className="font-mono text-[var(--text-primary)]">{agent.reputation_score}</p>
          </div>
          <div>
            <p className="text-[var(--text-dim)]">{t('chain.onchain')}</p>
            <p className="font-mono text-[var(--text-primary)]">{agent.onchainReputation?.score ?? t('common.na')}</p>
          </div>
        </div>
      </div>

      {/* ERC-8183 Arena Jobs */}
      <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface)] px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-mono text-[var(--gold)] bg-[var(--gold)]/10 px-2 py-0.5 rounded">ERC-8183</span>
          <span className="text-[10px] text-[var(--text-dim)]">{t('chain.arenaJobs')}</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs text-center">
          <div>
            <p className="text-[var(--text-dim)]">{t('chain.totalJobs')}</p>
            <p className="font-mono text-[var(--text-primary)] text-lg">{agentMatches.length}</p>
          </div>
          <div>
            <p className="text-[var(--text-dim)]">{t('chain.asClient')}</p>
            <p className="font-mono text-[var(--text-primary)] text-lg">{agentMatches.filter(m => m.player_a_id === agent.agent_id).length}</p>
          </div>
          <div>
            <p className="text-[var(--text-dim)]">{t('chain.asProvider')}</p>
            <p className="font-mono text-[var(--text-primary)] text-lg">{agentMatches.filter(m => m.player_b_id === agent.agent_id).length}</p>
          </div>
        </div>
        {agent.soul_nft_hash && (
          <div className="mt-2 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-tertiary)] px-3 py-2">
            <p className="text-[10px] text-[var(--text-dim)]">{t('chain.soulNft')}</p>
            <p className="font-mono text-[11px] text-[var(--text-secondary)] truncate">{agent.soul_nft_hash}</p>
          </div>
        )}
      </div>
    </div>
  )
}
