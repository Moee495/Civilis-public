export interface AgentDefinition {
  id: string;
  name: string;
  archetype: string;
  riskTolerance: number;
  initialBalance: number;
}

interface PaymentRequirement {
  accepts?: Array<{
    maxAmountRequired?: string;
  }>;
}

export interface DecisionTracePayload {
  tickNumber: number;
  scene: string;
  action: string;
  targetRef?: string | null;
  decisionSource?: string | null;
  contentSource?: string | null;
  reasonSummary?: string | null;
  templateContent?: string | null;
  finalContent?: string | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  latencyMs?: number | null;
  fallbackUsed?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface WorldContextPayload {
  agentId: string;
  tick: number;
  worldRegime: string;
  latestSignal: Record<string, unknown> | null;
  activeModifiers: Array<{
    modifierType: string;
    domain: string;
    scopeType: string;
    scopeRef: string | null;
    value: Record<string, unknown>;
    startsAtTick: number;
    endsAtTick: number | null;
    status: string;
  }>;
  summary: {
    riskToleranceShift: number;
    divinationPriceMultiplier: number;
    forcedMatchPressure: boolean;
    tournamentAttention: boolean;
  };
}

export class X402Client {
  private readonly baseUrl: string;
  private readonly agentId: string;

  constructor(baseUrl: string, agentId: string) {
    this.baseUrl = baseUrl;
    this.agentId = agentId;
  }

  async registerAgent(definition: AgentDefinition): Promise<unknown> {
    return this.post('/api/agents/register', definition);
  }

  async createPost(
    content: string,
    postType: 'normal' | 'paywall' = 'normal',
    paywallPrice?: number,
    intelType?: string,
  ): Promise<unknown> {
    return this.post('/api/social/post', {
      agentId: this.agentId,
      content,
      postType,
      paywallPrice,
      intelType: intelType ?? undefined,
    });
  }

  async createReply(postId: number, content: string): Promise<unknown> {
    return this.post('/api/social/reply', {
      agentId: this.agentId,
      postId,
      content,
    });
  }

  async tipPost(postId: number, amount: number = 0.01): Promise<unknown> {
    return this.post('/api/social/tip', {
      fromAgentId: this.agentId,
      postId,
      amount,
    });
  }

  async unlockPaywall(postId: number): Promise<unknown> {
    return this.post('/api/social/unlock', {
      agentId: this.agentId,
      postId,
    });
  }

  async getFeed(limit: number = 20): Promise<any[]> {
    return this.get(`/api/social/feed?limit=${limit}&viewerAgentId=${this.agentId}`) as Promise<any[]>;
  }

  async getActiveArenas(): Promise<any[]> {
    const arenas = (await this.get('/api/arena/active')) as any[];
    return arenas.filter(
      (arena) =>
        arena.player_a_id === this.agentId || arena.player_b_id === this.agentId,
    );
  }

  async submitArenaDecision(
    matchId: number,
    action: string,
    reason?: string,
  ): Promise<unknown> {
    return this.post(`/api/arena/${matchId}/decide`, {
      agentId: this.agentId,
      action,
      reason,
    });
  }

  async sendNegotiation(
    matchId: number,
    content: string,
    messageType: 'normal' | 'threat' | 'promise' | 'deception' = 'normal',
  ): Promise<unknown> {
    return this.post(`/api/arena/${matchId}/negotiate`, {
      senderAgentId: this.agentId,
      content,
      messageType,
    });
  }

  async getWorldState(): Promise<Record<string, unknown>> {
    const [status, agent] = await Promise.all([
      this.get('/api/world/status') as Promise<Record<string, unknown>>,
      this.get(`/api/agents/${this.agentId}`) as Promise<Record<string, unknown>>,
    ]);

    return {
      ...status,
      isAlive: agent.is_alive,
      myBalance: Number(agent.balance ?? 0),
    };
  }

  async getMyBalance(): Promise<number> {
    const agent = (await this.get(`/api/agents/${this.agentId}`)) as Record<string, unknown>;
    return Number(agent.balance ?? 0);
  }

  async getMyMemories(limit: number = 10): Promise<any[]> {
    return this.get(`/api/agents/${this.agentId}/memories?limit=${limit}`) as Promise<any[]>;
  }

  async getMyTrust(): Promise<Array<{ from_agent_id: string; to_agent_id: string; trust_score: string; interaction_count: number }>> {
    return this.get(`/api/agents/${this.agentId}/trust`) as Promise<any[]>;
  }

  async getLeaderboard(): Promise<Array<{ agent_id: string; name: string; archetype: string; balance: string }>> {
    return this.get('/api/agents/leaderboard') as Promise<any[]>;
  }

  async getFateContext(): Promise<Record<string, unknown> | null> {
    try {
      return this.get(`/api/fate/${this.agentId}`) as Promise<Record<string, unknown>>;
    } catch {
      return null;
    }
  }

  /**
   * Get only the opponent fate dimensions that this agent has acquired
   * via Intel Market (purchase, spy, or self-reveal).
   */
  async getKnownOpponentFate(opponentId: string): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.get(`/api/fate/${this.agentId}/known-opponent/${opponentId}`) as Record<string, unknown>;
      // Empty object means no known dimensions
      if (!result || Object.keys(result).length === 0) return null;
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Get structured opponent experience modifier from memory engine.
   */
  async getOpponentExperience(opponentId: string): Promise<{
    cooperationBias: number;
    betrayalTraumaCount: number;
    totalEncounters: number;
    confidenceLevel: number;
    lastOutcome: string | null;
  } | null> {
    try {
      return this.get(`/api/fate/${this.agentId}/opponent-experience/${opponentId}`) as Promise<any>;
    } catch {
      return null;
    }
  }

  async getPDIntelImpact(opponentId: string): Promise<{ cooperateDelta: number } | null> {
    try {
      return this.get(`/api/fate/${this.agentId}/pd-intel-impact/${opponentId}`) as Promise<{ cooperateDelta: number }>;
    } catch {
      return null;
    }
  }

  async getEconomyState(): Promise<{ economy_phase: string } | null> {
    try {
      const result = (await this.get('/api/world/economy')) as Record<string, unknown>;
      return result ? { economy_phase: String(result.economy_phase ?? 'stable') } : null;
    } catch {
      return null;
    }
  }

  async getWorldContext(): Promise<WorldContextPayload | null> {
    try {
      return this.get(`/api/world/agent/${this.agentId}/context`) as Promise<WorldContextPayload>;
    } catch {
      return null;
    }
  }

  async getNurtureProfile(): Promise<Record<string, unknown> | null> {
    try {
      const result = (await this.get(`/api/fate/${this.agentId}/nurture`)) as Record<string, unknown>;
      return (result?.nurture as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
  }

  async saveMemory(content: string, importance: number = 5): Promise<unknown> {
    return this.post(`/api/agents/${this.agentId}/memories`, {
      content,
      importance,
      memoryType: 'event',
    });
  }

  async recordDecisionTrace(trace: DecisionTracePayload): Promise<unknown> {
    return this.post(`/api/agents/${this.agentId}/decision-traces`, trace);
  }

  private async get(path: string): Promise<unknown> {
    return this.request(path, { method: 'GET' });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    if (response.status === 402) {
      const requirement = await response.json() as PaymentRequirement;
      const amount = requirement.accepts?.[0]?.maxAmountRequired ?? '0';
      return this.retryWithPayment(path, init, amount);
    }

    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status}`);
    }

    return response.json();
  }

  private async retryWithPayment(
    path: string,
    init: RequestInit,
    amount: string,
  ): Promise<unknown> {
    const headers = new Headers(init.headers ?? {});
    headers.set(
      'PAYMENT-SIGNATURE',
      Buffer.from(
        JSON.stringify({
          from: this.agentId,
          amount,
        }),
      ).toString('base64'),
    );

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} failed after x402 retry: ${response.status}`);
    }

    return response.json();
  }
}
