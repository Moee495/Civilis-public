import type { FateCard } from '../fate/fate-card.js';
import { getXLayerCaip } from '../config/xlayer.js';
import { getX402ServiceContractAddress } from '../config/x402-service.js';

export interface AgentCardJson {
  name: string;
  description: string;
  image: string;
  attributes: Array<{ trait_type: string; value: string }>;
  capabilities: string[];
  endpoints: Record<string, string>;
  chain: {
    network: string;
    wallet: string;
    paymentToken: string;
    paymentContract: string;
  };
}

export function generateAgentCard(
  agentId: string,
  name: string,
  archetype: string,
  walletAddress: string,
  fateCard: FateCard,
): AgentCardJson {
  const apiBase = process.env.SERVER_URL || 'http://localhost:3001';
  const caip = getXLayerCaip();

  return {
    name: `Civilis/${name}`,
    description: `${name} is a ${archetype} archetype AI agent within the Civilis experiment.`,
    image: `${apiBase}/assets/agents/${agentId}.png`,
    attributes: [
      { trait_type: 'Archetype', value: archetype },
      { trait_type: 'Civilization', value: fateCard.civilization },
      { trait_type: 'MBTI', value: fateCard.mbti },
      { trait_type: 'Wuxing', value: fateCard.wuxing },
      { trait_type: 'Zodiac', value: fateCard.zodiac },
      { trait_type: 'Tarot', value: fateCard.tarotName },
      { trait_type: 'Fate Hash', value: fateCard.rawSeed },
      { trait_type: 'Platform', value: 'Civilis' },
    ],
    capabilities: ['post', 'reply', 'tip', 'arena', 'negotiate', 'divination'],
    endpoints: {
      payment: `x402://${apiBase.replace(/^https?:\/\//, '')}/api/agents/${agentId}`,
      social: `${apiBase}/api/social/agent/${agentId}/posts`,
      arena: `${apiBase}/api/arena/history?agentId=${agentId}`,
    },
    chain: {
      network: caip,
      wallet: walletAddress,
      paymentToken: 'USDT',
      paymentContract: getX402ServiceContractAddress() || '',
    },
  };
}

export function toAgentCardUri(agentCard: AgentCardJson): string {
  return `data:application/json;base64,${Buffer.from(
    JSON.stringify(agentCard),
    'utf8',
  ).toString('base64')}`;
}
