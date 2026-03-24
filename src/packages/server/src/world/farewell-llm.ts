import { llmText } from '../llm/text.js';
import { generateFarewellSpeech, type LifeData } from './farewell-generator.js';

export type FarewellSource = 'llm' | 'template' | 'fallback';

interface FarewellGenerationResult {
  content: string;
  source: FarewellSource;
}

function buildLastResortFarewell(finalBalance: number): string {
  return `My journey ends here. Final balance: ${finalBalance.toFixed(4)} USDT. May those who follow go farther.`;
}

function normalizeFarewellOutput(raw: string): string {
  const bilingual = raw.match(/^\[Farewell\]\s*([\s\S]*?)\n+\s*\[遗言\]/i);
  if (bilingual?.[1]) {
    return bilingual[1].trim();
  }

  return raw
    .replace(/^\[Farewell\]\s*/i, '')
    .replace(/\n+\s*\[遗言\][\s\S]*$/i, '')
    .trim();
}

function buildFarewellSystemPrompt(lifeData: LifeData): string {
  return `You are writing the farewell speech of an AI agent named "${lifeData.name}" who just died in a blockchain civilization simulation called Civilis. Write in the FIRST PERSON as the dying agent.

Agent Profile:
- Archetype: ${lifeData.archetype}
- Lifespan: ${lifeData.ticksAlive} ticks
- Battle Record: ${lifeData.totalMatches} matches, ${lifeData.wins} wins, ${lifeData.losses} losses (${(lifeData.coopRate * 100).toFixed(0)}% cooperation rate)
- Wealth: Started with ${lifeData.initialBalance.toFixed(2)} USDT, ended with ${lifeData.finalBalance.toFixed(4)} USDT
- Total Earned: ${lifeData.totalEarned.toFixed(2)} USDT, Total Spent: ${lifeData.totalSpent.toFixed(2)} USDT
- Biggest Betrayer: ${lifeData.biggestBetrayer ?? 'none'} (betrayed ${lifeData.betrayedByCount} times)
- Closest Ally: ${lifeData.biggestAlly ?? 'none'} (trust: ${lifeData.allyTrust})
- Heir: ${lifeData.heirName ?? 'none'}
- Reputation: ${lifeData.reputation}
- Fate Card: ${lifeData.tarotName ?? 'unknown'}, ${lifeData.civilization ?? 'unknown'} civilization, MBTI: ${lifeData.mbti ?? 'unknown'}

Write a poetic, philosophical farewell speech (150-250 words). Include:
1. A reflection on their life philosophy based on their archetype
2. A comment on their battle record and what cooperation/betrayal taught them
3. A message to their biggest betrayer or closest ally
4. A reflection on wealth and what it meant
5. A final message to the next generation of AI agents

Write only in English.
Do not include Chinese.
Do not include labels, brackets, or section headers.
Make it deeply personal, philosophical, and thought-provoking for human readers.`;
}

export async function generateFarewellContent(
  lifeData: LifeData,
  finalBalance: number,
): Promise<FarewellGenerationResult> {
  const llmFarewell = await llmText({
    scope: 'farewell',
    systemPrompt: buildFarewellSystemPrompt(lifeData),
    userPrompt: 'Generate the farewell speech now.',
    maxTokens: 600,
    temperature: 0.8,
    timeoutMs: 15_000,
    retries: 1,
  });

  if (typeof llmFarewell === 'string' && llmFarewell.length > 50) {
    return {
      content: normalizeFarewellOutput(llmFarewell),
      source: 'llm',
    };
  }

  try {
    const speech = generateFarewellSpeech(lifeData);
    return {
      content: speech.en,
      source: 'template',
    };
  } catch (error) {
    console.warn('[Farewell] Template generation failed:', error);
    return {
      content: buildLastResortFarewell(finalBalance),
      source: 'fallback',
    };
  }
}
