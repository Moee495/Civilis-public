import './load-env.js';
import { makeDecision } from './decision-engine.js';
import type { AgentDecision } from './decision-engine.js';
import { polishDecisionContent } from './content-polish.js';
import { getPersonality } from './personalities/index.js';
import { X402Client } from './x402-client.js';
import type { AgentDefinition } from './x402-client.js';
import type { WorldContextPayload } from './x402-client.js';
import type { FateContext } from './fate-modifiers.js';
import type { NurtureProfile } from './nurture-engine.js';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const TICK_INTERVAL = 30_000;

export const PRESET_AGENTS: AgentDefinition[] = [
  { id: 'oracle', name: 'Oracle', archetype: 'oracle', riskTolerance: 0.3, initialBalance: 10 },
  { id: 'hawk', name: 'Hawk', archetype: 'hawk', riskTolerance: 0.9, initialBalance: 10 },
  { id: 'sage', name: 'Sage', archetype: 'sage', riskTolerance: 0.1, initialBalance: 10 },
  { id: 'fox', name: 'Fox', archetype: 'fox', riskTolerance: 0.5, initialBalance: 10 },
  { id: 'chaos', name: 'Chaos', archetype: 'chaos', riskTolerance: 0.7, initialBalance: 10 },
  { id: 'whale', name: 'Whale', archetype: 'whale', riskTolerance: 0.6, initialBalance: 10 },
  { id: 'monk', name: 'Monk', archetype: 'monk', riskTolerance: 0.2, initialBalance: 10 },
  { id: 'echo', name: 'Echo', archetype: 'echo', riskTolerance: 0.5, initialBalance: 10 },
];

const ARCHETYPE_DEFAULTS: Record<string, Pick<AgentDefinition, 'riskTolerance' | 'initialBalance'>> = {
  oracle: { riskTolerance: 0.3, initialBalance: 10 },
  hawk: { riskTolerance: 0.9, initialBalance: 10 },
  sage: { riskTolerance: 0.1, initialBalance: 10 },
  fox: { riskTolerance: 0.5, initialBalance: 10 },
  chaos: { riskTolerance: 0.7, initialBalance: 10 },
  whale: { riskTolerance: 0.6, initialBalance: 10 },
  monk: { riskTolerance: 0.2, initialBalance: 10 },
  echo: { riskTolerance: 0.5, initialBalance: 10 },
};

async function discoverRuntimeAgents(): Promise<AgentDefinition[]> {
  const bootstrapClient = new X402Client(SERVER_URL, 'civilis_runtime');
  const leaderboard = await bootstrapClient.getLeaderboard();

  const discovered = leaderboard
    .filter((agent) => (agent as { is_alive?: boolean }).is_alive !== false)
    .map((agent) => {
      const archetype = String(agent.archetype ?? 'echo').toLowerCase();
      const defaults = ARCHETYPE_DEFAULTS[archetype] ?? { riskTolerance: 0.5, initialBalance: 10 };

      return {
        id: String(agent.agent_id),
        name: String(agent.name ?? agent.agent_id),
        archetype,
        riskTolerance: defaults.riskTolerance,
        initialBalance: Number(agent.balance ?? defaults.initialBalance) || defaults.initialBalance,
      };
    });

  const canonicalIds = new Set(PRESET_AGENTS.map((agent) => agent.id));
  const canonical = discovered.filter((agent) => canonicalIds.has(agent.id));
  return canonical.length === PRESET_AGENTS.length ? canonical : discovered;
}

export async function runAgent(agent: AgentDefinition): Promise<void> {
  const personality = getPersonality(agent.archetype);
  const client = new X402Client(SERVER_URL, agent.id);

  console.log(`[${agent.name}] agent loop started (${agent.archetype})`);

  while (true) {
    try {
      const [worldState, feed, activeArenas, memories, balance, trustRelations, leaderboard, rawFate, rawNurture, rawEconomy, worldContext] = await Promise.all([
        client.getWorldState(),
        client.getFeed(10),
        client.getActiveArenas(),
        client.getMyMemories(10),
        client.getMyBalance(),
        client.getMyTrust(),
        client.getLeaderboard(),
        client.getFateContext(),
        client.getNurtureProfile(),
        client.getEconomyState(),
        client.getWorldContext(),
      ]);

      if (!worldState.isAlive) {
        console.log(`[${agent.name}] ☠️ dead, stopping loop.`);
        break;
      }

      // Build FateContext from server response
      const fateContext: FateContext | undefined = rawFate
        ? {
            mbti: String(rawFate.mbti ?? ''),
            wuxing: String(rawFate.wuxing ?? ''),
            zodiac: String(rawFate.zodiac ?? ''),
            tarotName: String(rawFate.tarotName ?? rawFate.tarot_name ?? ''),
            tarotState: (rawFate.tarotState ?? rawFate.tarot_state ?? 'upright') as 'upright' | 'reversed',
            civilization: String(rawFate.civilization ?? ''),
          }
        : undefined;

      // FIX-1: Load filtered opponent fate via Intel Market dimension filtering
      if (fateContext && activeArenas.length > 0) {
        const arena = activeArenas[0];
        const opponentId = arena.player_a_id === agent.id ? arena.player_b_id : arena.player_a_id;
        if (opponentId) {
          try {
            const rawOpponentFate = await client.getKnownOpponentFate(opponentId);
            if (rawOpponentFate) {
              fateContext.opponentFate = {
                mbti: rawOpponentFate.mbti ? String(rawOpponentFate.mbti) : undefined,
                wuxing: rawOpponentFate.wuxing ? String(rawOpponentFate.wuxing) : undefined,
                zodiac: rawOpponentFate.zodiac ? String(rawOpponentFate.zodiac) : undefined,
                tarotName: rawOpponentFate.tarotName ? String(rawOpponentFate.tarotName ?? rawOpponentFate.tarot_name ?? '') : undefined,
                tarotState: rawOpponentFate.tarotState ? (rawOpponentFate.tarotState as 'upright' | 'reversed') : undefined,
                civilization: rawOpponentFate.civilization ? String(rawOpponentFate.civilization) : undefined,
              } as Partial<FateContext>;
            }
          } catch (e) {
            // Silently ignore — opponent fate is optional
          }
        }
      }

      // Cast nurture profile from server response
      const nurtureProfile = (rawNurture as unknown) as NurtureProfile | undefined;

      // FIX-3: Fetch structured opponent experience for active arena
      let opponentExperience: {
        cooperationBias: number;
        betrayalTraumaCount: number;
        totalEncounters: number;
        confidenceLevel: number;
        lastOutcome: string | null;
      } | undefined;
      let pdIntelImpact: { cooperateDelta: number } | undefined;
      if (activeArenas.length > 0) {
        const arena = activeArenas[0];
        const opponentId = arena.player_a_id === agent.id ? arena.player_b_id : arena.player_a_id;
        if (opponentId) {
          try {
            const exp = await client.getOpponentExperience(opponentId);
            if (exp) opponentExperience = exp;
          } catch {
            // Silently ignore
          }
          if ((arena.match_type ?? 'prisoners_dilemma') === 'prisoners_dilemma') {
            try {
              const intel = await client.getPDIntelImpact(opponentId);
              if (intel) pdIntelImpact = intel;
            } catch {
              // Silently ignore
            }
          }
        }
      }

      // Extract economy phase from server response
      const economyPhase = rawEconomy?.economy_phase ?? 'stable';

      const decisionContext = {
        agentId: agent.id,
        personality,
        worldState,
        feed,
        activeArenas,
        memories,
        balance,
        riskTolerance: agent.riskTolerance,
        trustRelations,
        leaderboard,
        fateContext,
        nurtureProfile,
        opponentExperience,
        pdIntelImpact,
        economyPhase,
        worldContext: worldContext as WorldContextPayload | null,
      };

      const decision = await makeDecision(decisionContext);

      const templateContent = decision.content ?? null;
      const polished = await polishDecisionContent(decision, decisionContext);
      const finalDecision = polished.decision;
      const tracedArena = finalDecision.arenaMatchId
        ? activeArenas.find((arena) => Number(arena.id) === Number(finalDecision.arenaMatchId))
        : null;

      try {
        await client.recordDecisionTrace({
          tickNumber: Number(worldState.tick ?? worldState.current_tick ?? 0),
          scene: inferDecisionScene(finalDecision),
          action: finalDecision.action,
          targetRef: inferTargetRef(finalDecision),
          decisionSource: finalDecision.decisionSource ?? 'heuristic',
          contentSource: finalDecision.contentSource ?? 'none',
          reasonSummary: finalDecision.reason ?? null,
          templateContent,
          finalContent: finalDecision.content ?? null,
          llmProvider: polished.llmProvider,
          llmModel: polished.llmModel,
          latencyMs: polished.latencyMs,
          fallbackUsed: polished.fallbackUsed,
          metadata: {
            arenaMatchId: finalDecision.arenaMatchId ?? null,
            arenaAction: finalDecision.arenaAction ?? null,
            arenaRound: tracedArena?.current_round ?? null,
            arenaStatus: tracedArena?.status ?? null,
            matchType: tracedArena?.match_type ?? null,
            postType: finalDecision.postType ?? null,
            messageType: finalDecision.messageType ?? null,
          },
        });
      } catch (traceError) {
        console.warn(`[${agent.name}] decision trace failed:`, traceError);
      }

      await executeAction(client, agent, finalDecision);

      if (finalDecision.memoryNote) {
        await client.saveMemory(finalDecision.memoryNote, finalDecision.importance ?? 5);
      }

      console.log(
        `[${agent.name}] ${finalDecision.action}${finalDecision.reason ? ` - ${finalDecision.reason}` : ''} [decision=${finalDecision.decisionSource ?? 'unknown'}${finalDecision.contentSource && finalDecision.contentSource !== 'none' ? ` content=${finalDecision.contentSource}` : ''}]`,
      );
    } catch (error) {
      console.error(`[${agent.name}] tick failed:`, error);
    }

    const jitter = Math.random() * 5000;
    await sleep(TICK_INTERVAL + jitter);
  }
}

async function executeAction(
  client: X402Client,
  agent: AgentDefinition,
  decision: AgentDecision,
): Promise<void> {
  switch (decision.action) {
    case 'post':
      if (decision.content) {
        await client.createPost(
          decision.content,
          decision.postType ?? 'normal',
          decision.paywallPrice,
          decision.intelType,
        );
      }
      break;
    case 'reply':
      if (decision.targetPostId && decision.content) {
        await client.createReply(decision.targetPostId, decision.content);
      }
      break;
    case 'tip':
      if (decision.targetPostId) {
        await client.tipPost(decision.targetPostId, decision.tipAmount ?? 0.01);
      }
      break;
    case 'unlock_paywall':
      if (decision.targetPostId) {
        await client.unlockPaywall(decision.targetPostId);
      }
      break;
    case 'arena_decide':
      if (decision.arenaMatchId && decision.arenaAction) {
        await client.submitArenaDecision(
          decision.arenaMatchId,
          decision.arenaAction,
          decision.reason,
        );
      }
      break;
    case 'negotiate':
      if (decision.arenaMatchId && decision.content) {
        await client.sendNegotiation(
          decision.arenaMatchId,
          decision.content,
          decision.messageType ?? 'normal',
        );
      }
      break;
    case 'idle':
      break;
    default:
      console.warn(`[${agent.name}] unknown action ${(decision as { action?: string }).action}`);
      break;
  }
}

function inferDecisionScene(decision: AgentDecision): string {
  switch (decision.action) {
    case 'post':
    case 'reply':
    case 'tip':
    case 'unlock_paywall':
      return 'social';
    case 'arena_decide':
    case 'negotiate':
      return 'arena';
    case 'idle':
    default:
      return 'idle';
  }
}

function inferTargetRef(decision: AgentDecision): string | null {
  if (decision.targetPostId) {
    return `post:${decision.targetPostId}`;
  }
  if (decision.arenaMatchId) {
    return `arena:${decision.arenaMatchId}`;
  }
  return null;
}

export async function startAgentRuntime(): Promise<void> {
  let runtimeAgents: AgentDefinition[] = PRESET_AGENTS;

  try {
    const discoveredAgents = await discoverRuntimeAgents();
    if (discoveredAgents.length > 0) {
      runtimeAgents = discoveredAgents;
    }
  } catch (error) {
    console.warn('[AgentRuntime] Failed to discover live agents, falling back to preset 8:', error);
  }

  console.log(`
╔══════════════════════════════════════════════╗
║         Civilis Agent Runtime v3.0          ║
║──────────────────────────────────────────────║
║  Agents: ${String(runtimeAgents.length).padEnd(36)}║
║  Server: ${SERVER_URL.padEnd(36)}║
║  Tick:   30s                                ║
╚══════════════════════════════════════════════╝
  `);

  if (runtimeAgents === PRESET_AGENTS) {
    for (const agent of runtimeAgents) {
      const client = new X402Client(SERVER_URL, agent.id);
      try {
        await client.registerAgent(agent);
        console.log(`  ✅ ${agent.name} registered`);
      } catch (error) {
        console.log(`  ⚠️ ${agent.name} registration skipped: ${(error as Error).message}`);
      }
      await sleep(500);
    }
  } else {
    console.log(`  ✅ discovered ${runtimeAgents.length} live agents from server`);
  }

  await Promise.allSettled(runtimeAgents.map((agent) => runAgent(agent)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1]?.endsWith('agent-runtime.ts')) {
  startAgentRuntime().catch((error) => {
    console.error('Agent runtime startup failed:', error);
    process.exit(1);
  });
}
