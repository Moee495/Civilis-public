import { resolveApiBase } from './runtime-config'

export interface RealtimeEvent {
  type: string
  payload: Record<string, unknown>
  timestamp: string
}

export interface Stats {
  alive_agents: string
  dead_agents: string
  total_posts: string
  total_matches: string
  total_x402_txns: string
  total_x402_volume: string
  current_tick: string
  recentEvents: RealtimeEvent[]
}

export interface Agent {
  agent_id: string
  name: string
  archetype: string
  balance: string
  onchain_balance?: string | null
  reputation_score: number
  is_alive: boolean
  wallet_address: string
  wallet_provider?: string | null
  okx_account_id?: string | null
  okx_account_name?: string | null
  erc8004_token_id?: number | null
  soul_grade?: string | null
  soul_nft_hash?: string | null
  death_reason?: string | null
  died_at?: string | null
  mbti?: string
  wuxing?: string
  zodiac?: string
  tarot_name?: string
  civilization?: string
  onchainReputation?: {
    count: number
    score: number
  } | null
  protocolLayers?: {
    erc8004: {
      tokenId: number | null
      onChainReputation: {
        count: number
        score: number
      } | null
      alignment: ERC8004AlignmentStatus
    }
  }
}

export interface FeedReply {
  id: number
  authorAgentId: string
  authorName: string
  content: string
  createdAt: string
}

export interface FeedPost {
  id: number
  authorAgentId: string
  authorName: string
  authorArchetype: string
  content: string
  postType: 'normal' | 'paywall' | 'farewell'
  paywallPrice?: number
  isUnlocked: boolean
  tipTotal: number
  replyCount: number
  replies: FeedReply[]
  createdAt: string
}

export interface ArenaRound {
  id: number
  match_id: number
  round_number: number
  player_a_action: string
  player_a_reason?: string | null
  player_b_action: string
  player_b_reason?: string | null
  round_pool: string
  settle_amount: string
  carry_amount: string
  player_a_payout: string
  player_b_payout: string
  outcome: string
  created_at: string
}

export interface NegotiationMessage {
  id: number
  match_id: number
  sender_agent_id: string
  message_type: 'normal' | 'threat' | 'promise' | 'deception'
  content: string
  created_at: string
}

export interface ArenaMatch {
  id: number
  match_type: string
  player_a_id: string
  player_b_id: string
  entry_fee: string
  prize_pool: string
  total_rounds: number
  max_rounds: number
  current_round: number
  continue_probability: string
  carry_pool: string
  status: 'negotiating' | 'deciding' | 'resolving' | 'settled'
  negotiation_deadline?: string | null
  player_a_action?: string | null
  player_a_reason?: string | null
  player_b_action?: string | null
  player_b_reason?: string | null
  player_a_payout?: string | null
  player_b_payout?: string | null
  winner_id?: string | null
  settled_at?: string | null
  created_at: string
  rounds?: ArenaRound[]
}

export interface ArenaDecisionTrace extends AgentDecisionTrace {
  agent_name?: string | null
  agent_archetype?: string | null
}

export interface ArenaObserverSummary {
  source: 'template' | 'llm'
  headline: { zh: string; en: string }
  summary: { zh: string; en: string }
  insight: { zh: string; en: string }
  facts: {
    status: string
    matchType: string
    completedRounds: number
    configuredMaxRounds: number
    betrayalRounds: number
    negotiationMessages: number
    decisionTraces: number
    negotiationTraces: number
    lockedDecisionTraces: number
    llmContentTraces: number
    templateContentTraces: number
    dominantDecisionSource: 'heuristic' | 'mixed' | 'unknown'
    lastOutcome: string | null
  }
}

export interface ArenaMatchDetail extends ArenaMatch {
  negotiationMessages: NegotiationMessage[]
  rounds: ArenaRound[]
  decisionTraces: ArenaDecisionTrace[]
  observerSummary: ArenaObserverSummary | null
}

export interface WorldEvent {
  id: number
  event_type: string
  title: string
  description: string
  affected_agents: string[] | null
  impact: Record<string, unknown> | null
  category?: string | null
  severity?: string | null
  scope_type?: string | null
  scope_ref?: string | null
  tick_number: number
  starts_at_tick?: number | null
  ends_at_tick?: number | null
  source_signal_ref?: number | null
  engine_version?: string | null
  status?: string | null
  created_at: string
}

export interface WorldSignal {
  tickNumber: number
  worldRegime: string
  macro: Record<string, unknown>
  social: Record<string, unknown>
  externalMarket: {
    btcChange: number
    ethChange: number
    okbChange: number
    btcPrice: number
    ethPrice: number
    okbPrice: number
    source?: 'live' | 'mock'
    profile?: string | null
  } | null
  signalRefs: number[]
  createdAt: string
}

export interface WorldModifier {
  id: number
  sourceEventId: number | null
  modifierType: string
  domain: string
  scopeType: string
  scopeRef: string | null
  value: Record<string, unknown>
  startsAtTick: number
  endsAtTick: number | null
  status: 'active' | 'expired'
  createdAt: string
}

export interface WorldModifierStackPolicy {
  mode: 'additive' | 'multiplicative' | 'boolean_any' | 'latest_numeric'
  field: string
  note: string
  minValue?: number | null
  maxValue?: number | null
  maxContributors?: number | null
  dedupeBy?: 'none' | 'source_event_id' | 'scope_ref'
}

export interface WorldModifierStackSummary {
  modifierType: string
  domain: string
  scopeType: string
  scopeRef: string | null
  count: number
  mode: WorldModifierStackPolicy['mode']
  field: string
  sourceEventIds: number[]
  contributorCountUsed: number
  dedupeBy: NonNullable<WorldModifierStackPolicy['dedupeBy']>
  minValue: number | null
  maxValue: number | null
  maxContributors: number | null
  effectiveValue: number | boolean | null
  capped: boolean
}

export interface WorldTickRun {
  id: number
  tickNumber: number
  status: string
  signalCount: number
  eventCount: number
  primaryEventId: number | null
  snapshotTick: number | null
  snapshotPersisted: boolean
  worldRegime: string | null
  signalsWrittenAt: string | null
  eventsWrittenAt: string | null
  snapshotWrittenAt: string | null
  error: string | null
  metadata: Record<string, unknown>
  phaseStatus: {
    signalPhaseCompleted: boolean
    eventPhaseCompleted: boolean
    snapshotPhaseCompleted: boolean
    failurePhase: 'signal_phase' | 'event_phase' | 'snapshot_phase' | null
  }
  startedAt: string
  completedAt: string | null
}

export interface WorldOverview {
  status: {
    running: boolean
    tick: number
    runtimeTick?: number
    persistedTick?: number
    worldRegime: string
    total_events: string | number
    active_modifiers: string | number
    event_runs: string | number
    latestTickRun?: WorldTickRun | null
  }
  marketOracleStatus?: {
    requestedMode: 'live' | 'mock' | 'prefer_mock'
    lastResolvedSource: 'live' | 'mock' | 'none'
    lastProvider?: 'okx_node' | 'okx_python' | 'mock' | 'none'
    lastTransport?: 'node_fetch' | 'python_urllib' | 'mock' | 'none'
    liveTransportStrategy?: 'auto_live_with_python_fallback' | 'mock_only' | 'prefer_mock'
    nodeTransportStatus?: 'healthy' | 'fallback_active' | 'failed' | 'not_attempted'
    lastProfile: string | null
    lastAttemptedAt: string | null
    lastSucceededAt: string | null
    lastFailureAt: string | null
    lastFallbackReason: string | null
    lastError: string | null
  }
  latestSignal: WorldSignal | null
  activeModifiers: WorldModifier[]
  modifierStacks?: WorldModifierStackSummary[]
  recentSignals: Array<{
    id: number
    tick_number: number
    signal_type: string
    signal_key: string
    signal_value: string | null
    payload: Record<string, unknown>
    source: string
    created_at: string
  }>
  recentEvents: WorldEvent[]
}

export interface WorldAnalyticsSummary {
  tick: number
  worldRegime: string
  activeEventCount: number
  activeModifierCount: number
  latestTickRun: WorldTickRun | null
  windowBounds: {
    source: 'tick_snapshots'
    coverage: 'full' | 'partial' | 'insufficient'
    currentStartTick: number
    currentEndTick: number
    previousStartTick: number | null
    previousEndTick: number | null
    currentStartAt: string | null
    currentEndAt: string | null
    previousStartAt: string | null
    previousEndAt: string | null
    currentTickCoverage: number
    previousTickCoverage: number
  }
  activityComparisons: Array<{
    metric: string
    currentWindow: number
    previousWindow: number
    delta: number
    trend: 'up' | 'down' | 'flat'
  }>
  eventImpactComparisons: Array<{
    event: {
      id: number
      eventType: string
      title: string
      category: string
      severity: string
      status: string
      tickNumber: number
    }
    windowSizeTicks: number
    beforeBounds: {
      startTick: number
      endTick: number
      startAt: string | null
      endAt: string | null
      tickCoverage: number
      coverage: 'full' | 'partial' | 'insufficient'
    }
    afterBounds: {
      startTick: number
      endTick: number
      startAt: string | null
      endAt: string | null
      tickCoverage: number
      coverage: 'full' | 'partial' | 'insufficient'
    }
    overlapSummary: {
      overlappingEventCount: number
      overlappingEventIds: number[]
      overlapLevel: 'isolated' | 'mixed' | 'crowded'
      attributionConfidence: 'higher' | 'medium' | 'lower'
    }
    activityComparisons: Array<{
      metric: string
      currentWindow: number
      previousWindow: number
      delta: number
      trend: 'up' | 'down' | 'flat'
    }>
    dominantActivityDelta: {
      metric: string
      currentWindow: number
      previousWindow: number
      delta: number
      trend: 'up' | 'down' | 'flat'
    } | null
  }>
  modifierValidation: {
    emotionWindow: {
      coverage: 'full' | 'partial' | 'insufficient'
      currentTickCoverage: number
      previousTickCoverage: number
      currentRawAverageValence: number | null
      previousRawAverageValence: number | null
      rawValenceDelta: number | null
      currentRawAverageArousal: number | null
      previousRawAverageArousal: number | null
      rawArousalDelta: number | null
      currentEffectiveAverageValence: number | null
      previousEffectiveAverageValence: number | null
      effectiveValenceDelta: number | null
      currentEffectiveAverageArousal: number | null
      previousEffectiveAverageArousal: number | null
      effectiveArousalDelta: number | null
    }
    decisionTraceComparisons: Array<{
      metric: string
      currentWindow: number
      previousWindow: number
      delta: number
      trend: 'up' | 'down' | 'flat'
    }>
    activeModifierCounts: Array<{ modifierType: string; count: number }>
    naturalWindowValidations: Array<{
      modifierType: string
      naturalOccurrenceCount: number
      validationStatus: 'verified' | 'partial' | 'missing_natural_sample'
      latestEvent: {
        id: number
        eventType: string
        title: string
        tickNumber: number
        status: string
      } | null
      latestWindow: {
        startTick: number
        endTick: number
        coverage: 'full' | 'partial' | 'insufficient'
      } | null
      linkedArenaMatch: {
        matchId: number
        exists: boolean
        status: string | null
        totalRounds: number | null
        playerAId: string | null
        playerBId: string | null
        settledAt: string | null
      } | null
      activityEvidence: Array<{
        metric: string
        currentWindow: number
        previousWindow: number
        delta: number
        trend: 'up' | 'down' | 'flat'
      }>
      resolvedScopeValues: Array<{
        scopeRef: string
        effectiveValue: number | boolean | null
        contributorCount: number
      }>
      dominantDecisionTraceDelta: {
        metric: string
        currentWindow: number
        previousWindow: number
        delta: number
        trend: 'up' | 'down' | 'flat'
      } | null
      emotionWindow: {
        coverage: 'full' | 'partial' | 'insufficient'
        currentTickCoverage: number
        previousTickCoverage: number
        currentRawAverageValence: number | null
        previousRawAverageValence: number | null
        rawValenceDelta: number | null
        currentRawAverageArousal: number | null
        previousRawAverageArousal: number | null
        rawArousalDelta: number | null
        currentEffectiveAverageValence: number | null
        previousEffectiveAverageValence: number | null
        effectiveValenceDelta: number | null
        currentEffectiveAverageArousal: number | null
        previousEffectiveAverageArousal: number | null
        effectiveArousalDelta: number | null
      } | null
      note: string
    }>
    pdPayoutSemantics: {
      semanticsMode: 'treasury_cut_inverse'
      resolvedMultiplier: number
      contributorCount: number
      capped: boolean
      baseTreasuryCutRate: number
      effectiveTreasuryCutRate: number
      baseNetPoolShare: number
      effectiveNetPoolShare: number
      playerShareDelta: number
      note: string
      samplePrizePool: number
      baselineSample: {
        cooperateEach: number
        betrayWinner: number
        betrayLoser: number
        defectEach: number
        treasuryCC: number
        treasuryCD: number
        treasuryDD: number
      }
      effectiveSample: {
        cooperateEach: number
        betrayWinner: number
        betrayLoser: number
        defectEach: number
        treasuryCC: number
        treasuryCD: number
        treasuryDD: number
      }
    }
  }
  consumerCoverage: Array<{
    subsystem: 'agent' | 'social' | 'commons' | 'prediction' | 'arena' | 'fate_intel'
    modifierTypes: string[]
    activeModifierTypes: string[]
    activeModifierCount: number
    implementationStatus: 'connected' | 'partial'
    evidenceStatus: 'verified' | 'partial' | 'synthetic_only' | 'missing_natural_sample' | 'environment_dependent'
    currentStatus: 'active' | 'idle'
    note: string
  }>
  consumerIntegrationProgress: {
    overallPercent: number
    awardedPoints: number
    maxPoints: number
    breakdown: Array<{
      subsystem: 'agent' | 'social' | 'commons' | 'prediction' | 'arena' | 'fate_intel'
      awardedPoints: number
      maxPoints: number
      reason: string
    }>
  }
  modifierDomainCounts: Array<{ domain: string; count: number }>
  modifierTypeCounts: Array<{ modifierType: string; count: number }>
  recentEventCategoryCounts: Array<{ category: string; count: number }>
  recentEventSeverityCounts: Array<{ severity: string; count: number }>
  recentEventStatusCounts: Array<{ status: string; count: number }>
}

export interface TickSnapshot {
  tick_number: number
  agent_balances: Record<string, number>
  agent_reputations: Record<string, number>
  active_arena_count: number
  total_posts_today: number
  total_x402_volume: string
  average_valence?: number | null
  average_arousal?: number | null
  effective_average_valence?: number | null
  effective_average_arousal?: number | null
  created_at: string
}

export interface TrustRelation {
  from_agent_id: string
  to_agent_id: string
  trust_score: string
  interaction_count: number
  last_interaction_at?: string | null
}

export interface X402Transaction {
  id: number
  tx_type: string
  from_agent_id?: string | null
  to_agent_id?: string | null
  amount: string
  tx_hash?: string | null
  metadata?: Record<string, unknown> | null
  created_at: string
}

export interface EconomyState {
  economy_phase: string
  actual_ratio: number
  pg_base_injection: number
  pd_treasury_cut: number
  pp_treasury_cut: number
  total_agent_balance: number
  treasury_balance: number
  tick_number: number
  snapshot_tick_number?: number
  current_tick?: number
  target_money_supply?: number
  derived?: boolean
}

export interface AgentWorldContext {
  agentId: string
  tick: number
  worldRegime: string
  latestSignal: WorldSignal | null
  activeModifiers: WorldModifier[]
  modifierStacks?: WorldModifierStackSummary[]
  summary: {
    riskToleranceShift: number
    riskToleranceShiftBreakdown: Array<{
      modifierId: number
      sourceEventId: number | null
      value: Record<string, unknown>
      startsAtTick: number
      endsAtTick: number | null
    }>
    riskToleranceShiftPolicy?: WorldModifierStackPolicy
    riskToleranceShiftCapped?: boolean
    riskToleranceShiftContributorCount?: number
    divinationPriceMultiplier: number
    divinationPriceMultiplierBreakdown: Array<{
      modifierId: number
      sourceEventId: number | null
      value: Record<string, unknown>
      startsAtTick: number
      endsAtTick: number | null
    }>
    divinationPriceMultiplierPolicy?: WorldModifierStackPolicy
    divinationPriceMultiplierCapped?: boolean
    divinationPriceMultiplierContributorCount?: number
    forcedMatchPressure: boolean
    forcedMatchPressureBreakdown: Array<{
      modifierId: number
      sourceEventId: number | null
      value: Record<string, unknown>
      startsAtTick: number
      endsAtTick: number | null
    }>
    forcedMatchPressurePolicy?: WorldModifierStackPolicy
    forcedMatchPressureContributorCount?: number
    tournamentAttention: boolean
    tournamentAttentionBreakdown: Array<{
      modifierId: number
      sourceEventId: number | null
      value: Record<string, unknown>
      startsAtTick: number
      endsAtTick: number | null
    }>
    tournamentAttentionPolicy?: WorldModifierStackPolicy
    tournamentAttentionContributorCount?: number
  }
}

export interface AgentWorldExposure {
  agentId: string
  tick: number
  worldRegime: string
  globalModifierCount: number
  scopedModifierCount: number
  recentEventCount: number
  activeModifiers: WorldModifier[]
  modifierStacks: WorldModifierStackSummary[]
  recentEvents: Array<{
    id: number
    eventType: string
    title: string
    category: string
    severity: string
    tickNumber: number
    status: string
    affectedAgents: string[]
    scopeType: string
    scopeRef: string | null
    createdAt: string
  }>
  domainCounts: Array<{ domain: string; count: number }>
}

export interface AgentCommerceSummary {
  agentId: string
  cashflow: {
    totalEarned: number
    totalSpent: number
    netCashflow: number
  }
  intelCommerce: {
    totalListings: number
    activeCount: number
    pendingCount: number
    soldCount: number
    listingRevenue: number
    estimatedAcquisitionCost: number
    estimatedGrossProfit: number
    costCoverageCount: number
  }
  recentSales: Array<{
    saleKind?: 'fate_listing' | 'intel_v2'
    saleRefId?: number
    listingId: number
    subjectAgentId: string | null
    subjectName: string | null
    subjectArchetype: string | null
    dimension: string
    salePrice: number
    status: string
    buyerAgentId: string | null
    buyerName: string | null
    acpJobLocalId: number | null
    acpTxHash: string | null
    saleX402TxHash: string | null
    sourceType: string
    estimatedAcquisitionCost: number | null
    estimatedGrossProfit: number | null
    createdAt: string
    soldAt: string | null
  }>
}

export interface AgentDecisionTrace {
  id: number
  agent_id: string
  tick_number: number
  scene: string
  action: string
  target_ref?: string | null
  decision_source: string
  content_source: string
  reason_summary?: string | null
  template_content?: string | null
  final_content?: string | null
  llm_provider?: string | null
  llm_model?: string | null
  latency_ms?: number | null
  fallback_used: boolean
  metadata?: Record<string, unknown> | null
  created_at: string
}

export interface AgentReputationSummary {
  count: number
  averageValue: number
  onChainCount: number
  onChainAverageValue: number
}

export interface AgentValidationSummary {
  totalValidations: number
  averageScore: number
  fakeCount: number
  verifiedCount: number
}

export type ProtocolAddressSource = 'v2_env' | 'legacy_env_alias' | 'unset'
export type LayerSyncState = 'empty' | 'local_only' | 'mixed'

export interface ACPProtocolDescriptor {
  surface: 'v2' | 'mock'
  configured: boolean
  contractAddress: string | null
  addressSource: ProtocolAddressSource
  paymentToken: string | null
  hookMode: 'optional'
  writeSemantics: 'erc8183_v2' | 'mock'
  notes: string[]
}

export interface ERC8004IdentityProtocolState {
  configured: boolean
  contractAddress: string | null
  addressSource: ProtocolAddressSource
  registrationWriteMode: 'owner_mint_required' | 'mock'
  walletProofModes: Array<'eip712' | 'erc1271'>
}

export interface ERC8004ReputationProtocolState {
  configured: boolean
  contractAddress: string | null
  addressSource: ProtocolAddressSource
  feedbackWriteMode: 'client_signer_required' | 'mock'
  summarySource: 'tracked_onchain_clients' | 'local_only'
}

export interface ERC8004ValidationProtocolState {
  configured: boolean
  contractAddress: string | null
  addressSource: ProtocolAddressSource
  requestWriteMode: 'owner_or_operator_required' | 'mock'
  responseWriteMode: 'assigned_validator_required' | 'mock'
}

export interface ERC8004AlignmentStatus {
  identity: ERC8004IdentityProtocolState
  reputation: ERC8004ReputationProtocolState
  validation: ERC8004ValidationProtocolState
}

export interface CommerceProtocolState {
  configured: boolean
  mode: 'v2_mapping' | 'legacy_job_registry' | 'mock'
  addressSource: ProtocolAddressSource
  mappingOnly: boolean
  notes: string[]
}

export interface ReputationLedgerView {
  localLedger: {
    count: number
    averageValue: number
  }
  onChainSummary: {
    count: number
    averageValue: number
    clientScope: 'tracked_onchain_clients'
    clientCount: number
  } | null
  syncState: LayerSyncState
}

export interface ValidationLedgerView {
  localLedger: {
    totalValidations: number
    averageScore: number
    fakeCount: number
    verifiedCount: number
  }
  onChainSummary: {
    count: number
    averageScore: number
  } | null
  syncState: LayerSyncState
}

export interface Erc8004OverviewAgentRow {
  agent_id: string
  name: string
  archetype: string
  erc8004_token_id: number | null
  reputation_score: number
  is_alive: boolean
  feedbackCount: number
  localAverageValue: number | null
  onChainFeedbackCount: number
  onChainAverageValue: number | null
  validationCount: number
  verifiedValidationCount: number
  protocolLayers: {
    reputation: ReputationLedgerView
    validation: ValidationLedgerView
  }
}

export interface Erc8004Overview {
  protocol: ERC8004AlignmentStatus
  totals: {
    totalAgents: number
    registeredAgents: number
    totalFeedback: number
    pendingFeedback: number
    totalValidations: number
    respondedValidations: number
  }
  agents: Erc8004OverviewAgentRow[]
}

export interface CommonsRound {
  id: number
  round_number: number
  tick_number: number
  base_injection: string
  prediction_loss_pool: string
  contribute_total: string
  multiplier: string
  sabotage_damage: string
  final_pool: string
  cooperation_rate: string
  participant_count: number
  contributor_count: number
  freerider_count: number
  hoarder_count: number
  saboteur_count: number
  economy_phase: string
  created_at: string
}

export interface CommonsDecision {
  id: number
  round_id: number
  agent_id: string
  name: string
  archetype: string
  decision: 'contribute' | 'free_ride' | 'hoard' | 'sabotage'
  reason?: string
  score_snapshot?: Record<string, number> | null
  cost: string
  weight: string
  payout: string
  net_profit: string
  contribute_streak: number
  freeriding_streak: number
  sabotage_detected: boolean
  reputation_change: number
}

export interface PredictionRound {
  id: number
  round_number: number
  start_tick: number
  end_tick: number
  phase: string
  coin_a: string
  coin_b: string
  start_price_a: string
  start_price_b: string
  end_price_a?: string
  end_price_b?: string
  change_pct_a?: string
  change_pct_b?: string
  actual_winner?: string
  relative_diff?: string
  prize_pool: string
  treasury_cut: string
  pg_return: string
  flash_settled: boolean
  created_at: string
  settled_at?: string
}

export interface PredictionPosition {
  id: number
  round_id: number
  agent_id: string
  name: string
  archetype: string
  chosen_coin: string
  position_type: string
  entry_fee: string
  base_odds: string
  closed_early: boolean
  final_pnl?: string
  payout: string
  prediction_correct?: boolean
  magnitude_correct?: boolean
  reasoning?: string
}

export interface PredictionAgentStats {
  total_predictions: string
  correct_predictions: string
  magnitude_correct: string
  accuracy: string
  total_payout: string
  total_spent: string
  net_pnl: string
  hedge_count: string
  big_count: string
  early_close_count: string
}

// ── Intel Market V2 Types ──

export interface IntelItemV2 {
  id: number
  category: string
  producer_agent_id: string
  producer_name: string
  producer_archetype: string
  subject_agent_id: string | null
  subject_name: string | null
  subject_archetype: string | null
  content: { type: string; summary: string; data: Record<string, unknown> }
  accuracy: number
  declared_accuracy: number
  is_fake: boolean
  freshness: number
  price: string
  buyer_count: number
  is_public: boolean
  status: string
  expires_at_tick: number
  created_at_tick: number
  consensus_reached_at_tick?: number | null
  public_after_tick?: number | null
  public_revealed_at_tick?: number | null
  last_buyer_agent_id?: string | null
  ticks_until_public?: number
  public_delay_ticks?: number
  market_state?: 'listed' | 'sealed' | 'public'
  verified_accuracy: number | null
  created_at: string
  market_signal?: IntelMarketSignal | null
}

export interface IntelMarketStats {
  activeItems: number
  sealedItems?: number
  totalItems: number
  totalPurchases: number
  totalVolume: number
  fakeRate: number
  avgVerifiedAccuracy: number | null
  activeProducers: number
}

export interface IntelMarketSignal {
  demandScore: number
  demandTier: 'critical' | 'high' | 'medium' | 'low'
  impactDomains: string[]
  effectSummaryZh: string
  effectSummaryEn: string
  saleReasonZh: string
  saleReasonEn: string
  subjectInArena: boolean
  predictionWindow: boolean
}

export interface IntelItemV2Buyer {
  id: number
  intel_item_id: number
  buyer_agent_id: string
  price_paid: string
  purchased_at_tick: number
  created_at: string
  name: string
  archetype: string
}

export interface IntelItemV2Detail {
  item: IntelItemV2
  buyers: IntelItemV2Buyer[]
}

export interface IntelPhaseSnapshot {
  agentId: string
  phase: 'initial' | 'awakened' | 'insightful'
  unlocks: {
    selfDiscover: boolean
    buy: boolean
    spy: boolean
    trade: boolean
  }
  metrics: {
    pdMatches: number
    peakBalanceRatio: number
    ticksAlive: number
    reputationScore: number
    deadCount: number
    totalMatches: number
    phaseChanges: number
    selfKnownCount: number
    foreignKnownCount: number
    listableIntelCount: number
  }
  requirements: {
    awakened: Array<{ key: string; value: number; target: number; met: boolean }>
    insightful: Array<{ key: string; value: number; target: number; met: boolean }>
  }
}

export interface IntelKnowledgeOverview {
  records: Array<{
    subject_agent_id: string
    dimension: string
    knower_agent_id: string
    source_type: string
    subject_name: string
    subject_archetype: string
    knower_name: string
    knower_archetype: string
  }>
  recentActivity: Array<{
    subject_agent_id: string
    subject_name: string
    subject_archetype: string
    knower_agent_id: string
    knower_name: string
    knower_archetype: string
    dimension: string
    source_type: string
    can_sell: boolean
    created_at: string
  }>
  agentSummary: Array<{
    agent_id: string
    name: string
    archetype: string
    self_known: string
    known_by_others: string
    unique_self_dims: string
    spied_by_count: string
    listable_count: number | string
    phase: 'initial' | 'awakened' | 'insightful'
    unlocks: IntelPhaseSnapshot['unlocks']
    phase_metrics: IntelPhaseSnapshot['metrics']
  }>
  totalRecords: number
}

export interface IntelCreditScoreRow {
  agent_id: string
  name?: string
  archetype?: string
  total_produced: number
  total_verified: number
  average_accuracy: number
  fake_count: number
  credit_score: number
  tier: string
}

export interface IntelCounterEvent {
  id: number
  spy_agent_id: string
  spy_name: string
  spy_archetype: string
  target_agent_id: string
  target_name: string
  target_archetype: string
  detected: boolean
  reaction: string | null
  tick_number: number
  created_at: string
}

// ── Death Analysis ──
export interface DeathAnalysis {
  agent: { agentId: string; name: string; archetype: string; soulGrade: string; soulHash: string; deathReason: string; diedAt: string; initialBalance: number; finalBalance: number; reputation: number }
  fateCard: Record<string, unknown> | null
  battle: { totalMatches: number; wins: number; losses: number; coopRate: number; totalEarnedArena: number; totalLostArena: number }
  betrayers: Array<{ name: string; agentId: string; count: number }>
  trustAtDeath: Array<{ name: string; archetype: string; trustScore: number }>
  wealthFlow: Array<{ txType: string; direction: string; volume: number; count: number }>
  balanceCurve: Array<{ tick: number; balance: number }>
  keyMoments: { biggestWin: { opponent: string; payout: number } | null; biggestLoss: { opponent: string; payout: number } | null }
  inheritance: { heirName: string | null; amount: number } | null
  farewell: string | null
}

// ── Fate Knowledge Map ──
export interface FateKnowledgeMap {
  agentId: string
  viewerId: string | null
  dimensions: Array<{
    dimension: string
    status: 'public' | 'self_known' | 'spied' | 'purchased' | 'unknown'
    isPublic: boolean
    value: string | null
    knowerCount: number
    publicThreshold: number
    knowers: Array<{ agentId: string; sourceType: string; isSelf: boolean }>
  }>
  totalKnown: number
  totalPublic: number
}

// ── ERC-8183 ACP Job (local cache of on-chain state) ──
export interface ACPJob {
  id: number
  on_chain_job_id: number
  category: string
  tx_type: string
  client_agent_id: string | null
  provider_agent_id: string | null
  evaluator_address: string
  budget: string
  status: string
  hook_address: string | null
  deliverable_hash: string | null
  reason_hash: string | null
  metadata: Record<string, unknown> | null
  recordOnly?: boolean
  valueBacked?: boolean
  on_chain_tx_hash: string | null
  created_at: string
  funded_at: string | null
  submitted_at: string | null
  settled_at: string | null
  protocolLayers?: {
    localLedger: {
      recordLayer: 'local_cache'
      status: string
    }
    escrow8183: {
      protocolVersion: string | null
      addressSource: ProtocolAddressSource | null
      paymentToken: string | null
      budgetUnits: string | null
      onChainTxHash: string | null
      syncState: 'local_only' | 'mixed'
      recordOnly?: boolean
      valueBacked?: boolean
    }
  }
}

export interface ACPStats {
  localLedger: {
    total: number
    byStatus: Record<string, number>
    byCategory: Record<string, number>
    totalVolume: number
    completedCount: number
    completedVolume: number
    activeCount: number
    terminalCount: number
    valueBackedCount: number
    valueBackedVolume: number
    valueBackedByCategory: Record<string, number>
    recordOnlyCount: number
    recordOnlyByCategory: Record<string, number>
    arenaSubtypeCounts: Record<string, number>
  }
  onChainSync: {
    jobCount: number
    volume: number
    valueBackedJobCount: number
    valueBackedVolume: number
    recordOnlyJobCount: number
  }
  protocolLayers: {
    escrow8183: ACPProtocolDescriptor
    trust8004: ERC8004AlignmentStatus
    commerceMapping: CommerceProtocolState
    x402Rail: {
      configured: boolean
      paymentMode: string
      network: string
      directWalletMode: boolean
    }
  }
  queues: {
    pendingReputationFeedback: number
  }
}

export interface AgentReputationViewResponse {
  agentId: string
  erc8004TokenId: number
  protocol: ERC8004ReputationProtocolState
  overall: ReputationLedgerView
  breakdown: Record<string, ReputationLedgerView>
  recentFeedback: Array<{ value: number; tag1: string; tag2: string; onChain: boolean; createdAt: string }>
}

export interface AgentValidationViewResponse {
  agentId: string
  erc8004TokenId: number
  protocol: ERC8004ValidationProtocolState
  validation: ValidationLedgerView
}

function withParams(path: string, params?: Record<string, string | number | undefined>) {
  if (!params) return path
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) search.set(key, String(value))
  })
  const query = search.toString()
  return query ? `${path}?${query}` : path
}

async function getJSON<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const response = await fetch(`${resolveApiBase()}${withParams(path, params)}`, {
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`)
  }

  return response.json() as Promise<T>
}

async function postJSON<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`API Error: ${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

function normalizeCommonsScoreSnapshot(
  value: unknown,
): Record<string, number> | null {
  if (!value) return null

  const raw = typeof value === 'string'
    ? (() => {
        try {
          return JSON.parse(value) as unknown
        } catch {
          return null
        }
      })()
    : value

  if (!raw || typeof raw !== 'object') return null

  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([key, score]) => [key, typeof score === 'number' ? score : Number(score)] as const)
    .filter(([, score]) => Number.isFinite(score))

  return entries.length ? Object.fromEntries(entries) : null
}

function normalizeCommonsDecision(decision: CommonsDecision): CommonsDecision {
  return {
    ...decision,
    reason: typeof decision.reason === 'string' ? decision.reason : undefined,
    score_snapshot: normalizeCommonsScoreSnapshot(decision.score_snapshot),
  }
}

export interface IntelPost {
  id: number
  author_agent_id: string
  author_name: string
  author_archetype: string
  content: string
  post_type: 'paywall'
  paywall_price: string
  intel_type: 'arena_analysis' | 'trust_map' | 'behavior_prediction' | 'market_signal'
  tip_total: string
  unlock_count: string
  created_at: string
}

export interface IntelListing {
  id: number
  seller_agent_id: string
  seller_name: string
  seller_archetype: string
  subject_agent_id: string
  subject_name: string
  subject_archetype: string
  dimension: string
  source_type?: string
  price: string
  status: string
  buyer_agent_id?: string | null
  acp_job_local_id?: number | null
  sale_x402_tx_hash?: string | null
  created_at: string
}

export interface IntelHolding {
  subject_agent_id: string
  subject_name: string
  subject_archetype: string
  dimension: string
  source_type: string
  value: string | null
  sellable?: boolean
  created_at: string
}

export const api = {
  getStats: () => getJSON<Stats>('/api/stats'),
  getAgents: () => getJSON<Agent[]>('/api/agents'),
  getLeaderboard: () => getJSON<Agent[]>('/api/agents/leaderboard'),
  getAgent: (id: string) => getJSON<Agent>(`/api/agents/${id}`),
  getAgentMemories: (id: string, limit: number = 20) =>
    getJSON<Array<{ content: string; importance: number; created_at: string }>>(`/api/agents/${id}/memories`, { limit }),
  getAgentTrust: (id: string) => getJSON<TrustRelation[]>(`/api/agents/${id}/trust`),
  getAgentTransactions: (id: string, limit: number = 50) =>
    getJSON<X402Transaction[]>(`/api/agents/${id}/transactions`, { limit }),
  getFeed: (params?: { sort?: string; limit?: number; viewerAgentId?: string }) =>
    getJSON<FeedPost[]>('/api/social/feed', params),
  getAgentPosts: (id: string, viewerAgentId?: string) =>
    getJSON<FeedPost[]>(`/api/social/agent/${id}/posts`, { viewerAgentId }),
  getActiveArenas: () => getJSON<ArenaMatch[]>('/api/arena/active', { observer: 'true' }),
  getArenaHistory: (params?: { limit?: number; agentId?: string }) =>
    getJSON<ArenaMatch[]>('/api/arena/history', params),
  getMatch: (id: number) => getJSON<ArenaMatchDetail>(`/api/arena/${id}`),
  getMatchRounds: (id: number) => getJSON<ArenaRound[]>(`/api/arena/${id}/rounds`),
  getFateCard: (agentId: string) => getJSON<Record<string, unknown>>(`/api/fate/${agentId}`),
  getWorldStatus: () => getJSON<Record<string, unknown>>('/api/world/status'),
  getWorldEvents: (limit: number = 50) => getJSON<WorldEvent[]>('/api/world/events', { limit }),
  getWorldOverview: (limit: number = 10) => getJSON<WorldOverview>('/api/world/overview', { limit }),
  getWorldAnalyticsSummary: (window: number = 20) =>
    getJSON<WorldAnalyticsSummary>('/api/world/analytics/summary', { window }),
  getAgentWorldContext: (agentId: string) =>
    getJSON<AgentWorldContext>(`/api/world/agent/${agentId}/context`),
  getAgentWorldExposure: (agentId: string, window: number = 20) =>
    getJSON<AgentWorldExposure>(`/api/world/agent/${agentId}/exposure`, { window }),
  getWorldModifiers: (params?: { status?: 'active' | 'expired'; limit?: number }) =>
    getJSON<WorldModifier[]>('/api/world/modifiers', params),
  getLatestWorldSignal: () => getJSON<WorldSignal | null>('/api/world/signals/latest'),
  getSnapshots: (limit: number = 50) => getJSON<TickSnapshot[]>('/api/world/snapshots', { limit }),
  getWorldTrust: () => getJSON<TrustRelation[]>('/api/world/trust'),
  getTransactions: (limit: number = 50) => getJSON<X402Transaction[]>('/api/world/transactions', { limit }),
  getDeaths: () => getJSON<Agent[]>('/api/world/deaths'),
  getDeathAnalysis: (agentId: string) => getJSON<DeathAnalysis>(`/api/world/death-analysis/${agentId}`),
  getIntelFeed: (params?: { intelType?: string; limit?: number; offset?: number }) =>
    getJSON<IntelPost[]>('/api/social/intel', params),
  getIntelStatus: (agentId: string) =>
    getJSON<Record<string, number>>(`/api/fate/${agentId}/intel-status`),
  getIntelListings: (params?: { dimension?: string; subjectAgentId?: string; limit?: number; offset?: number }) =>
    getJSON<IntelListing[]>('/api/fate/intel/listings', params),
  getIntelHoldings: (agentId: string) =>
    getJSON<IntelHolding[]>(`/api/fate/${agentId}/holdings`),
  getNurtureProfile: (agentId: string) =>
    getJSON<{ agent_id: string; nurture: Record<string, any> }>(`/api/fate/${agentId}/nurture`),
  getArchetypeProfile: (agentId: string) =>
    getJSON<Record<string, any>>(`/api/agents/${agentId}/archetype`),
  getEconomyState: () =>
    getJSON<EconomyState>('/api/world/economy'),
  // ── Commons (Public Goods) ──
  getCommonsCurrent: async () => {
    const result = await getJSON<{ round: CommonsRound | null; decisions: CommonsDecision[] }>('/api/commons/current')
    return {
      ...result,
      decisions: result.decisions.map(normalizeCommonsDecision),
    }
  },
  getCommonsHistory: (params?: { limit?: number; offset?: number }) =>
    getJSON<CommonsRound[]>('/api/commons/history', params),
  getCommonsAgentStats: (agentId: string) =>
    getJSON<Record<string, unknown>>(`/api/commons/agent/${agentId}`),
  getCommonsLeaderboard: () =>
    getJSON<Array<{ agent_id: string; name: string; archetype: string; contributions: number; coop_rate: number; net_profit: number }>>('/api/commons/leaderboard'),
  // ── Prediction (Oracle's Eye) ──
  getPredictionCurrent: () =>
    getJSON<{ round: PredictionRound | null; positions: PredictionPosition[] }>('/api/prediction/current'),
  getPredictionPrices: () =>
    getJSON<{ prices: Record<string, number>; timestamp: string }>('/api/prediction/prices'),
  getPredictionPriceHistory: (pair: string, limit = 30) =>
    getJSON<Array<{ price: string; tick_number: number; fetched_at: string }>>('/api/prediction/price-history', { pair, limit }),
  getPredictionHistory: (params?: { limit?: number; offset?: number }) =>
    getJSON<PredictionRound[]>('/api/prediction/history', params),
  getPredictionAgentStats: (agentId: string) =>
    getJSON<PredictionAgentStats>(`/api/prediction/agent/${agentId}`),
  getPredictionLeaderboard: () =>
    getJSON<Array<{ agent_id: string; name: string; archetype: string; accuracy: number; net_pnl: number }>>('/api/prediction/leaderboard'),
  // ── Round Detail (for click-to-expand) ──
  getCommonsRoundDetail: async (roundId: number) => {
    const result = await getJSON<{ round: CommonsRound; decisions: CommonsDecision[] }>(`/api/commons/round/${roundId}`)
    return {
      ...result,
      decisions: result.decisions.map(normalizeCommonsDecision),
    }
  },
  getPredictionRoundDetail: (roundId: number) =>
    getJSON<{ round: PredictionRound; positions: PredictionPosition[] }>(`/api/prediction/round/${roundId}`),
  // ── Intel Market V2 ──
  getIntelV2Items: (params?: { category?: string; producer?: string; subject?: string; limit?: number; offset?: number }) =>
    getJSON<{ items: IntelItemV2[]; total: number; limit: number; offset: number }>('/api/intel/items', params),
  getIntelV2ItemDetail: (id: number) =>
    getJSON<IntelItemV2Detail>(`/api/intel/items/${id}`),
  getIntelV2History: (params?: { category?: string; limit?: number; offset?: number }) =>
    getJSON<{ items: IntelItemV2[]; total: number; limit: number; offset: number }>('/api/intel/history', params),
  getIntelV2Stats: () =>
    getJSON<IntelMarketStats>('/api/intel/stats'),
  getIntelV2Leaderboard: () =>
    getJSON<Array<IntelCreditScoreRow>>('/api/intel/leaderboard'),
  getIntelV2CounterEvents: (params?: { limit?: number }) =>
    getJSON<IntelCounterEvent[]>('/api/intel/counter-events', params),
  getIntelV2Credit: (agentId: string) =>
    getJSON<IntelCreditScoreRow>(`/api/intel/credit/${agentId}`),
  getIntelV2Produced: (agentId: string) =>
    getJSON<IntelItemV2[]>(`/api/intel/produced/${agentId}`),
  getIntelV2Purchases: (agentId: string) =>
    getJSON<IntelItemV2[]>(`/api/intel/purchases/${agentId}`),
  getIntelKnowledgeOverview: () =>
    getJSON<IntelKnowledgeOverview>('/api/intel/knowledge-overview'),
  postIntelV2Resell: (itemId: number, sellerAgentId: string, resalePrice: number) =>
    postJSON<{ id: number }>(`/api/intel/items/${itemId}/resell`, { sellerAgentId, resalePrice }),
  postIntelV2Buy: (itemId: number, buyerAgentId: string) =>
    postJSON<{ success: boolean }>(`/api/intel/items/${itemId}/buy`, { buyerAgentId }),
  // ── Fate Knowledge Map ──
  getFateKnowledgeMap: (agentId: string, viewerId?: string) =>
    getJSON<FateKnowledgeMap>(`/api/fate/${agentId}/knowledge-map`, viewerId ? { viewerId } : undefined),
  getFateIntelPhase: (agentId: string) =>
    getJSON<IntelPhaseSnapshot>(`/api/fate/${agentId}/intel-phase`),
  // ── ERC-8183 ACP (Agentic Commerce Protocol) ──
  getACPStats: () =>
    getJSON<ACPStats>('/api/acp/stats'),
  getACPJobs: (params?: { category?: string; status?: string; agent?: string; limit?: number; arenaType?: string }) =>
    getJSON<{ jobs: ACPJob[]; total: number }>('/api/acp/jobs', params),
  getACPJob: (id: number) =>
    getJSON<ACPJob>(`/api/acp/jobs/${id}`),
  // ── ERC-8004 Reputation ──
  getAgentReputation: (agentId: string) =>
    getJSON<AgentReputationViewResponse>(`/api/acp/reputation/${agentId}`),
  getAgentReputationHistory: (agentId: string, limit = 100) =>
    getJSON<{ agentId: string; feedback: Array<{ value: number; tag1: string; tag2: string; onChain: boolean; createdAt: string }> }>(`/api/acp/reputation/${agentId}/history`, { limit }),
  getAgentCommerceSummary: (agentId: string, limit = 20) =>
    getJSON<AgentCommerceSummary>(`/api/agents/${agentId}/commerce-summary`, { limit }),
  getAgentDecisionTraces: (agentId: string, limit = 20) =>
    getJSON<AgentDecisionTrace[]>(`/api/agents/${agentId}/decision-traces`, { limit }),
  getERC8004Overview: () =>
    getJSON<Erc8004Overview>('/api/acp/erc8004/overview'),
  // ── ERC-8004 Validations ──
  getAgentValidations: (agentId: string) =>
    getJSON<AgentValidationViewResponse>(`/api/acp/validations/${agentId}`),
  // ── X402 Payment Analytics ──
  getX402Stats: () =>
    getJSON<X402FullStats>('/api/acp/x402/stats'),
  getX402OfficialSupported: () =>
    getJSON<X402OfficialSupported>('/api/acp/x402/official/supported'),
}

// ── X402 Analytics Types ──
export interface X402OfficialSupported {
  configured: boolean
  reachable?: boolean
  provider: string
  endpoint?: string
  receivedAt?: string
  normalized?: {
    schemes: string[]
    networks: string[]
    assets: string[]
    combinations: Array<{ scheme: string; network: string; asset?: string }>
  }
  raw?: unknown
  error?: string
}

export interface X402FullStats {
  overview: {
    totalTransactions: number
    totalVolume: number
    uniqueSenders: number
    uniqueReceivers: number
    firstTransaction: string | null
    lastTransaction: string | null
    averageTxSize: number
  }
  lifecycle: Record<string, { count: number; volume: number }>
  official: {
    configured: boolean
    network: string
    paymentMode: 'direct_wallet' | 'async_bridge'
    directWalletMode: boolean
    targetNetwork: string
    targetPaymentMode: 'direct_wallet' | 'async_bridge'
    directWalletRequiresMainnet: boolean
    directWalletSemantics?: 'proof_first' | 'transition_contract_call'
    recommendedOkxSkills?: string[]
  }
  byType: Array<{ txType: string; count: number; volume: number; avgAmount: number; minAmount: number; maxAmount: number }>
  hourlyVolume: Array<{ hour: string; count: number; volume: number }>
  dailyVolume: Array<{ day: string; count: number; volume: number }>
  topSenders: Array<{ agentId: string; name: string; archetype: string; txCount: number; totalSent: number }>
  topReceivers: Array<{ agentId: string; name: string; archetype: string; txCount: number; totalReceived: number }>
  treasuryFlows: Record<string, { count: number; volume: number }>
  agentNetFlow: Array<{ agentId: string; name: string; archetype: string; totalEarned: number; totalSpent: number; netFlow: number }>
  avgByType: Array<{ txType: string; avgSize: number; medianSize: number }>
  recentTransactions: Array<{
    id: number
    txType: string
    from: string | null
    to: string | null
    amount: number
    txHash: string | null
    metadata: Record<string, unknown> | null
    createdAt: string
    onchainStatus: string
    onchainAttempts: number
    onchainPaymentId: number | null
    onchainError: string | null
    settlementStatus: string | null
    settlementCreatedAt: string | null
    confirmedAt: string | null
    proofProvider: string | null
    proofVerifiedAt: string | null
    proofSettledAt: string | null
    proofPayerAddress: string | null
    proofPayeeAddress: string | null
    explorerUrl: string | null
  }>
}
