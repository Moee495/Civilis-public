import { Pool, PoolClient } from 'pg';

let pool: Pool | undefined;

function createPool(): Pool {
  const nextPool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://user:password@localhost:5432/civilis',
  });

  nextPool.on('error', (error) => {
    console.error('[db] pool client error:', error);
  });

  return nextPool;
}

export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }

  return pool;
}

const SCHEMA_QUERIES = [
  'DROP TABLE IF EXISTS daily_mvp CASCADE',
  'DROP TABLE IF EXISTS daily_challenges CASCADE',
  'DROP TABLE IF EXISTS service_calls CASCADE',
  'DROP TABLE IF EXISTS trades CASCADE',
  'DROP TABLE IF EXISTS advices CASCADE',
  'DROP TABLE IF EXISTS signals CASCADE',
  `CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    wallet_address VARCHAR(255) UNIQUE NOT NULL,
    archetype VARCHAR(50) NOT NULL,
    risk_tolerance DECIMAL(3,2) NOT NULL,
    balance DECIMAL(20,6) DEFAULT 100.0,
    initial_balance DECIMAL(20,6) DEFAULT 100.0,
    reputation_score INT DEFAULT 500,
    is_alive BOOLEAN DEFAULT true,
    death_reason TEXT,
    died_at TIMESTAMPTZ,
    soul_nft_hash VARCHAR(255),
    erc8004_token_id INT,
    soul_grade VARCHAR(20),
    last_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fate_cards (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    block_hash VARCHAR(255) NOT NULL,
    block_number BIGINT NOT NULL,
    mbti VARCHAR(4) NOT NULL,
    wuxing VARCHAR(10) NOT NULL,
    zodiac VARCHAR(20) NOT NULL,
    tarot_major INT NOT NULL,
    tarot_name VARCHAR(50) NOT NULL,
    civilization VARCHAR(20) NOT NULL,
    element_detail JSONB NOT NULL,
    raw_seed VARCHAR(255) NOT NULL,
    is_revealed BOOLEAN DEFAULT false,
    revealed_dimensions JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    author_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    content TEXT NOT NULL,
    post_type VARCHAR(20) DEFAULT 'normal',
    paywall_price DECIMAL(20,6),
    tip_total DECIMAL(20,6) DEFAULT 0,
    reply_count INT DEFAULT 0,
    x402_tx_hash VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_agent_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_posts_tips ON posts(tip_total DESC)',
  `CREATE TABLE IF NOT EXISTS replies (
    id SERIAL PRIMARY KEY,
    post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    content TEXT NOT NULL,
    x402_tx_hash VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id, created_at)',
  `CREATE TABLE IF NOT EXISTS tips (
    id SERIAL PRIMARY KEY,
    from_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    to_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    post_id INT REFERENCES posts(id),
    amount DECIMAL(20,6) NOT NULL,
    x402_tx_hash VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tips_to ON tips(to_agent_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS paywall_unlocks (
    id SERIAL PRIMARY KEY,
    post_id INT NOT NULL REFERENCES posts(id),
    buyer_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    price DECIMAL(20,6) NOT NULL,
    x402_tx_hash VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, buyer_agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS arena_matches (
    id SERIAL PRIMARY KEY,
    match_type VARCHAR(30) NOT NULL,
    player_a_id TEXT NOT NULL REFERENCES agents(agent_id),
    player_b_id TEXT NOT NULL REFERENCES agents(agent_id),
    entry_fee DECIMAL(20,6) DEFAULT 1.0,
    prize_pool DECIMAL(20,6) DEFAULT 2.0,
    total_rounds INT DEFAULT 5,
    max_rounds INT DEFAULT 5,
    current_round INT DEFAULT 1,
    continue_probability DECIMAL(3,2) DEFAULT 0.70,
    carry_pool DECIMAL(20,6) DEFAULT 0,
    rounds_data JSONB DEFAULT '[]',
    status VARCHAR(20) DEFAULT 'negotiating',
    negotiation_deadline TIMESTAMPTZ,
    player_a_action VARCHAR(20),
    player_a_reason TEXT,
    player_b_action VARCHAR(20),
    player_b_reason TEXT,
    player_a_payout DECIMAL(20,6) DEFAULT 0,
    player_b_payout DECIMAL(20,6) DEFAULT 0,
    winner_id TEXT REFERENCES agents(agent_id),
    settled_at TIMESTAMPTZ,
    x402_entry_a_hash VARCHAR(255),
    x402_entry_b_hash VARCHAR(255),
    commerce_job_id BIGINT,
    acp_job_local_id INTEGER,
    commerce_sync_status VARCHAR(20) DEFAULT 'pending',
    commerce_sync_error TEXT,
    commerce_settled_tx_hash VARCHAR(255),
    acp_sync_status VARCHAR(20) DEFAULT 'pending',
    acp_sync_error TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_arena_status ON arena_matches(status, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS arena_rounds (
    id SERIAL PRIMARY KEY,
    match_id INT NOT NULL REFERENCES arena_matches(id) ON DELETE CASCADE,
    round_number INT NOT NULL,
    player_a_action VARCHAR(20) NOT NULL,
    player_a_reason TEXT,
    player_b_action VARCHAR(20) NOT NULL,
    player_b_reason TEXT,
    round_pool DECIMAL(20,6) NOT NULL,
    settle_amount DECIMAL(20,6) NOT NULL,
    carry_amount DECIMAL(20,6) NOT NULL,
    player_a_payout DECIMAL(20,6) NOT NULL,
    player_b_payout DECIMAL(20,6) NOT NULL,
    outcome VARCHAR(5) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(match_id, round_number)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_arena_rounds_match ON arena_rounds(match_id, round_number)',
  `CREATE TABLE IF NOT EXISTS negotiation_messages (
    id SERIAL PRIMARY KEY,
    match_id INT NOT NULL REFERENCES arena_matches(id) ON DELETE CASCADE,
    sender_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    receiver_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'normal',
    x402_tx_hash VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_negotiation_match ON negotiation_messages(match_id, created_at)',
  `CREATE TABLE IF NOT EXISTS world_events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    affected_agents TEXT[],
    impact JSONB,
    category VARCHAR(30) DEFAULT 'system',
    severity VARCHAR(20) DEFAULT 'info',
    scope_type VARCHAR(20) DEFAULT 'global',
    scope_ref TEXT,
    tick_number INT NOT NULL,
    starts_at_tick INT,
    ends_at_tick INT,
    source_signal_ref INT,
    engine_version VARCHAR(20) DEFAULT 'v1',
    status VARCHAR(20) DEFAULT 'recorded',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_world_events_tick ON world_events(tick_number DESC)',
  `CREATE TABLE IF NOT EXISTS world_signals (
    id SERIAL PRIMARY KEY,
    tick_number INT NOT NULL,
    signal_type VARCHAR(20) NOT NULL,
    signal_key VARCHAR(80) NOT NULL,
    signal_value DECIMAL(20,6),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    source VARCHAR(40) DEFAULT 'tick_engine',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tick_number, signal_type, signal_key)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_world_signals_tick ON world_signals(tick_number DESC)',
  'CREATE INDEX IF NOT EXISTS idx_world_signals_type ON world_signals(signal_type, tick_number DESC)',
  `CREATE TABLE IF NOT EXISTS world_modifiers (
    id SERIAL PRIMARY KEY,
    source_event_id INT REFERENCES world_events(id) ON DELETE SET NULL,
    modifier_type VARCHAR(60) NOT NULL,
    domain VARCHAR(40) NOT NULL,
    scope_type VARCHAR(20) NOT NULL DEFAULT 'global',
    scope_ref TEXT,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    starts_at_tick INT NOT NULL,
    ends_at_tick INT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_world_modifiers_status ON world_modifiers(status, starts_at_tick DESC)',
  'CREATE INDEX IF NOT EXISTS idx_world_modifiers_scope ON world_modifiers(scope_type, scope_ref, status)',
  `CREATE TABLE IF NOT EXISTS world_event_runs (
    id SERIAL PRIMARY KEY,
    tick_number INT NOT NULL,
    engine_name VARCHAR(40) NOT NULL,
    candidate_type VARCHAR(60),
    status VARCHAR(20) NOT NULL,
    reason TEXT,
    signal_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    event_id INT REFERENCES world_events(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_world_event_runs_tick ON world_event_runs(tick_number DESC, engine_name)',
  `CREATE TABLE IF NOT EXISTS world_tick_runs (
    id SERIAL PRIMARY KEY,
    tick_number INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'started',
    signal_count INT NOT NULL DEFAULT 0,
    event_count INT NOT NULL DEFAULT 0,
    primary_event_id INT REFERENCES world_events(id) ON DELETE SET NULL,
    snapshot_tick INT,
    snapshot_persisted BOOLEAN NOT NULL DEFAULT false,
    world_regime VARCHAR(30),
    signals_written_at TIMESTAMPTZ,
    events_written_at TIMESTAMPTZ,
    snapshot_written_at TIMESTAMPTZ,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
  )`,
  'CREATE INDEX IF NOT EXISTS idx_world_tick_runs_tick ON world_tick_runs(tick_number DESC, started_at DESC)',
  `CREATE TABLE IF NOT EXISTS x402_transactions (
    id SERIAL PRIMARY KEY,
    tx_type VARCHAR(30) NOT NULL,
    from_agent_id TEXT REFERENCES agents(agent_id),
    to_agent_id TEXT REFERENCES agents(agent_id),
    amount DECIMAL(20,6) NOT NULL,
    tx_hash VARCHAR(255),
    onchain_payment_id BIGINT,
    onchain_status VARCHAR(20) DEFAULT 'local_confirmed',
    onchain_error TEXT,
    onchain_attempts INT DEFAULT 0,
    proof_provider TEXT,
    proof_header_name VARCHAR(40),
    proof_payload JSONB,
    proof_requirements JSONB,
    proof_authorization JSONB,
    proof_signature TEXT,
    proof_verify_endpoint TEXT,
    proof_verify_response JSONB,
    proof_verified_at TIMESTAMPTZ,
    proof_settle_endpoint TEXT,
    proof_settle_response JSONB,
    proof_settled_at TIMESTAMPTZ,
    proof_payer_address TEXT,
    proof_payee_address TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_x402_type ON x402_transactions(tx_type, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_x402_from ON x402_transactions(from_agent_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_x402_to ON x402_transactions(to_agent_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_x402_created ON x402_transactions(created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_x402_status ON x402_transactions(onchain_status, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS trust_relations (
    id SERIAL PRIMARY KEY,
    from_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    to_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    trust_score DECIMAL(5,2) DEFAULT 50.0,
    interaction_count INT DEFAULT 0,
    last_interaction_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_agent_id, to_agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_memories (
    id SERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    memory_type VARCHAR(30) NOT NULL,
    content JSONB NOT NULL DEFAULT '{}',
    importance REAL DEFAULT 0.5,
    tick_created INT NOT NULL,
    tick_last_accessed INT,
    access_count INT DEFAULT 0,
    decay_rate REAL DEFAULT 0.01,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_memories_agent ON agent_memories(agent_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memories_type ON agent_memories(agent_id, memory_type)',
  `CREATE TABLE IF NOT EXISTS agent_decision_traces (
    id SERIAL PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    tick_number INTEGER DEFAULT 0,
    scene VARCHAR(30) NOT NULL,
    action VARCHAR(30) NOT NULL,
    target_ref TEXT,
    decision_source VARCHAR(30) DEFAULT 'heuristic',
    content_source VARCHAR(30) DEFAULT 'none',
    reason_summary TEXT,
    template_content TEXT,
    final_content TEXT,
    llm_provider VARCHAR(30),
    llm_model VARCHAR(120),
    latency_ms INTEGER,
    fallback_used BOOLEAN DEFAULT false,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_decision_traces_agent ON agent_decision_traces(agent_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_decision_traces_scene ON agent_decision_traces(scene, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS tick_snapshots (
    tick_number SERIAL PRIMARY KEY,
    agent_balances JSONB NOT NULL,
    agent_reputations JSONB NOT NULL,
    active_arena_count INT DEFAULT 0,
    total_posts_today INT DEFAULT 0,
    total_x402_volume DECIMAL(20,6) DEFAULT 0,
    world_event_id INT REFERENCES world_events(id),
    world_regime VARCHAR(30) DEFAULT 'stable',
    active_modifier_count INT DEFAULT 0,
    active_event_count INT DEFAULT 0,
    average_valence REAL,
    average_arousal REAL,
    effective_average_valence REAL,
    effective_average_arousal REAL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS intel_records (
    id SERIAL PRIMARY KEY,
    subject_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    dimension VARCHAR(20) NOT NULL,
    knower_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    source_type VARCHAR(20) NOT NULL DEFAULT 'self_reveal',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(subject_agent_id, dimension, knower_agent_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_intel_records_subject ON intel_records(subject_agent_id, dimension)',
  'CREATE INDEX IF NOT EXISTS idx_intel_records_knower ON intel_records(knower_agent_id)',
  `CREATE TABLE IF NOT EXISTS intel_listings (
    id SERIAL PRIMARY KEY,
    seller_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    subject_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    dimension VARCHAR(20) NOT NULL,
    price DECIMAL(20,6) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    buyer_agent_id TEXT REFERENCES agents(agent_id),
    acp_job_local_id INTEGER,
    sale_x402_tx_hash VARCHAR(255),
    sold_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_intel_listings_status ON intel_listings(status, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_intel_listings_seller ON intel_listings(seller_agent_id)',
];

const MIGRATIONS = [
  // Performance indexes for frequent queries
  'CREATE INDEX IF NOT EXISTS idx_agents_alive_balance ON agents(is_alive, balance) WHERE is_alive = true',
  `ALTER TABLE world_events ADD COLUMN IF NOT EXISTS category VARCHAR(30) DEFAULT 'system'`,
  `ALTER TABLE world_events ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'info'`,
  `ALTER TABLE world_events ADD COLUMN IF NOT EXISTS scope_type VARCHAR(20) DEFAULT 'global'`,
  `ALTER TABLE world_events ADD COLUMN IF NOT EXISTS scope_ref TEXT`,
  `ALTER TABLE world_events ADD COLUMN IF NOT EXISTS starts_at_tick INT`,
  `ALTER TABLE world_events ADD COLUMN IF NOT EXISTS ends_at_tick INT`,
  `ALTER TABLE world_events ADD COLUMN IF NOT EXISTS source_signal_ref INT`,
  `ALTER TABLE world_events ADD COLUMN IF NOT EXISTS engine_version VARCHAR(20) DEFAULT 'v1'`,
  `ALTER TABLE world_events ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'recorded'`,
  `ALTER TABLE tick_snapshots ADD COLUMN IF NOT EXISTS world_regime VARCHAR(30) DEFAULT 'stable'`,
  `ALTER TABLE tick_snapshots ADD COLUMN IF NOT EXISTS active_modifier_count INT DEFAULT 0`,
  `ALTER TABLE tick_snapshots ADD COLUMN IF NOT EXISTS active_event_count INT DEFAULT 0`,
  `ALTER TABLE tick_snapshots ADD COLUMN IF NOT EXISTS average_valence REAL`,
  `ALTER TABLE tick_snapshots ADD COLUMN IF NOT EXISTS average_arousal REAL`,
  `ALTER TABLE tick_snapshots ADD COLUMN IF NOT EXISTS effective_average_valence REAL`,
  `ALTER TABLE tick_snapshots ADD COLUMN IF NOT EXISTS effective_average_arousal REAL`,
  `CREATE TABLE IF NOT EXISTS world_signals (
    id SERIAL PRIMARY KEY,
    tick_number INT NOT NULL,
    signal_type VARCHAR(20) NOT NULL,
    signal_key VARCHAR(80) NOT NULL,
    signal_value DECIMAL(20,6),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    source VARCHAR(40) DEFAULT 'tick_engine',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tick_number, signal_type, signal_key)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_world_signals_tick ON world_signals(tick_number DESC)',
  'CREATE INDEX IF NOT EXISTS idx_world_signals_type ON world_signals(signal_type, tick_number DESC)',
  `CREATE TABLE IF NOT EXISTS world_modifiers (
    id SERIAL PRIMARY KEY,
    source_event_id INT REFERENCES world_events(id) ON DELETE SET NULL,
    modifier_type VARCHAR(60) NOT NULL,
    domain VARCHAR(40) NOT NULL,
    scope_type VARCHAR(20) NOT NULL DEFAULT 'global',
    scope_ref TEXT,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    starts_at_tick INT NOT NULL,
    ends_at_tick INT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_world_modifiers_status ON world_modifiers(status, starts_at_tick DESC)',
  'CREATE INDEX IF NOT EXISTS idx_world_modifiers_scope ON world_modifiers(scope_type, scope_ref, status)',
  `CREATE TABLE IF NOT EXISTS world_event_runs (
    id SERIAL PRIMARY KEY,
    tick_number INT NOT NULL,
    engine_name VARCHAR(40) NOT NULL,
    candidate_type VARCHAR(60),
    status VARCHAR(20) NOT NULL,
    reason TEXT,
    signal_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    event_id INT REFERENCES world_events(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_world_event_runs_tick ON world_event_runs(tick_number DESC, engine_name)',
  `CREATE TABLE IF NOT EXISTS world_tick_runs (
    id SERIAL PRIMARY KEY,
    tick_number INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'started',
    signal_count INT NOT NULL DEFAULT 0,
    event_count INT NOT NULL DEFAULT 0,
    primary_event_id INT REFERENCES world_events(id) ON DELETE SET NULL,
    snapshot_tick INT,
    snapshot_persisted BOOLEAN NOT NULL DEFAULT false,
    world_regime VARCHAR(30),
    signals_written_at TIMESTAMPTZ,
    events_written_at TIMESTAMPTZ,
    snapshot_written_at TIMESTAMPTZ,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ
  )`,
  'CREATE INDEX IF NOT EXISTS idx_world_tick_runs_tick ON world_tick_runs(tick_number DESC, started_at DESC)',
  `ALTER TABLE world_tick_runs ADD COLUMN IF NOT EXISTS signals_written_at TIMESTAMPTZ`,
  `ALTER TABLE world_tick_runs ADD COLUMN IF NOT EXISTS events_written_at TIMESTAMPTZ`,
  `ALTER TABLE world_tick_runs ADD COLUMN IF NOT EXISTS snapshot_written_at TIMESTAMPTZ`,

  // Add multi-round snowball columns to arena_matches (safe to re-run)
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='arena_matches' AND column_name='total_rounds') THEN
      ALTER TABLE arena_matches ADD COLUMN total_rounds INT DEFAULT 3;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='arena_matches' AND column_name='current_round') THEN
      ALTER TABLE arena_matches ADD COLUMN current_round INT DEFAULT 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='arena_matches' AND column_name='carry_pool') THEN
      ALTER TABLE arena_matches ADD COLUMN carry_pool DECIMAL(20,6) DEFAULT 0;
    END IF;
  END $$`,
  // Backfill existing settled matches: set total_rounds=1 so they display correctly
  `UPDATE arena_matches SET total_rounds = 1, current_round = 1, carry_pool = 0 WHERE status = 'settled' AND total_rounds = 3`,
  // Add Axelrod probabilistic continuation columns
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='arena_matches' AND column_name='max_rounds') THEN
      ALTER TABLE arena_matches ADD COLUMN max_rounds INT DEFAULT 5;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='arena_matches' AND column_name='continue_probability') THEN
      ALTER TABLE arena_matches ADD COLUMN continue_probability DECIMAL(3,2) DEFAULT 0.70;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='arena_matches' AND column_name='rounds_data') THEN
      ALTER TABLE arena_matches ADD COLUMN rounds_data JSONB DEFAULT '[]';
    END IF;
  END $$`,
  `ALTER TABLE arena_matches ADD COLUMN IF NOT EXISTS player_a_reason TEXT`,
  `ALTER TABLE arena_matches ADD COLUMN IF NOT EXISTS player_b_reason TEXT`,
  `ALTER TABLE intel_items ADD COLUMN IF NOT EXISTS consensus_reached_at_tick INTEGER`,
  `ALTER TABLE intel_items ADD COLUMN IF NOT EXISTS public_after_tick INTEGER`,
  `ALTER TABLE intel_items ADD COLUMN IF NOT EXISTS public_revealed_at_tick INTEGER`,
  `ALTER TABLE intel_items ADD COLUMN IF NOT EXISTS last_buyer_agent_id TEXT REFERENCES agents(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_intel_items_public_after ON intel_items(public_after_tick) WHERE public_after_tick IS NOT NULL AND is_public = false`,
  `ALTER TABLE intel_listings ADD COLUMN IF NOT EXISTS acp_job_local_id INTEGER`,
  `ALTER TABLE intel_listings ADD COLUMN IF NOT EXISTS sale_x402_tx_hash VARCHAR(255)`,
  `ALTER TABLE arena_matches ADD COLUMN IF NOT EXISTS commerce_job_id BIGINT`,
  `ALTER TABLE arena_matches ADD COLUMN IF NOT EXISTS acp_job_local_id INTEGER`,
  `ALTER TABLE arena_matches ADD COLUMN IF NOT EXISTS commerce_sync_status VARCHAR(20) DEFAULT 'pending'`,
  `ALTER TABLE arena_matches ADD COLUMN IF NOT EXISTS commerce_sync_error TEXT`,
  `ALTER TABLE arena_matches ADD COLUMN IF NOT EXISTS commerce_settled_tx_hash VARCHAR(255)`,
  `ALTER TABLE arena_matches ADD COLUMN IF NOT EXISTS acp_sync_status VARCHAR(20) DEFAULT 'pending'`,
  `ALTER TABLE arena_matches ADD COLUMN IF NOT EXISTS acp_sync_error TEXT`,
  `ALTER TABLE arena_rounds ADD COLUMN IF NOT EXISTS player_a_reason TEXT`,
  `ALTER TABLE arena_rounds ADD COLUMN IF NOT EXISTS player_b_reason TEXT`,
  `UPDATE arena_matches
   SET commerce_sync_status = CASE
     WHEN commerce_settled_tx_hash IS NOT NULL THEN 'settled'
     WHEN commerce_job_id IS NOT NULL THEN 'ready'
     ELSE COALESCE(commerce_sync_status, 'pending')
   END
   WHERE commerce_sync_status IS NULL
      OR commerce_sync_status = ''
      OR (commerce_job_id IS NOT NULL AND commerce_sync_status = 'pending')`,
  `UPDATE arena_matches
   SET acp_sync_status = CASE
     WHEN acp_job_local_id IS NOT NULL THEN 'ready'
     ELSE COALESCE(acp_sync_status, 'pending')
   END
   WHERE acp_sync_status IS NULL
      OR acp_sync_status = ''
      OR (acp_job_local_id IS NOT NULL AND acp_sync_status = 'pending')`,
  'CREATE INDEX IF NOT EXISTS idx_arena_commerce_sync ON arena_matches(commerce_sync_status, settled_at)',
  'CREATE INDEX IF NOT EXISTS idx_arena_acp_sync ON arena_matches(acp_sync_status, settled_at)',
  // Backfill max_rounds for existing matches
  `UPDATE arena_matches SET max_rounds = total_rounds WHERE max_rounds IS NULL OR max_rounds = 5`,
  // Add intel_type column to posts for Intel Market
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='intel_type') THEN
      ALTER TABLE posts ADD COLUMN intel_type VARCHAR(30) DEFAULT NULL;
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_posts_intel_type ON posts(intel_type) WHERE intel_type IS NOT NULL`,
  // Add initial_tarot_state column to fate_cards (FIX-2)
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='fate_cards' AND column_name='initial_tarot_state') THEN
      ALTER TABLE fate_cards ADD COLUMN initial_tarot_state VARCHAR(10) DEFAULT 'upright';
    END IF;
  END $$`,
  // ── Nurture (Acquired) Dimension Tables ──
  `CREATE TABLE IF NOT EXISTS agent_combat_experience (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    total_matches INTEGER DEFAULT 0,
    experience_level INTEGER DEFAULT 0,
    pd_experience INTEGER DEFAULT 0,
    rg_experience INTEGER DEFAULT 0,
    ia_experience INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    current_streak INTEGER DEFAULT 0,
    longest_win_streak INTEGER DEFAULT 0,
    longest_lose_streak INTEGER DEFAULT 0,
    cooperation_count INTEGER DEFAULT 0,
    betrayal_count INTEGER DEFAULT 0,
    overall_coop_rate REAL DEFAULT 0.5,
    opponent_models JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_trauma (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    total_betrayals_received INTEGER DEFAULT 0,
    total_betrayals_given INTEGER DEFAULT 0,
    betrayal_ratio REAL DEFAULT 0,
    trauma_state TEXT DEFAULT 'healthy',
    resilience REAL DEFAULT 0.5,
    forgiveness_capacity REAL DEFAULT 0.5,
    ptg_score REAL DEFAULT 0,
    ptg_domains JSONB DEFAULT '{"lifeAppreciation":0,"relatingToOthers":0,"personalStrength":0,"newPossibilities":0,"philosophicalChange":0}',
    trauma_records JSONB DEFAULT '{}',
    last_betrayal_tick INTEGER DEFAULT 0,
    ticks_since_last_betrayal INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_wealth_psychology (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    initial_balance REAL DEFAULT 10.0,
    peak_balance REAL DEFAULT 10.0,
    trough_balance REAL DEFAULT 10.0,
    balance_trend TEXT DEFAULT 'stable',
    wealth_percentile REAL DEFAULT 50,
    wealth_class TEXT DEFAULT 'middle',
    loss_aversion REAL DEFAULT 2.25,
    house_money_effect REAL DEFAULT 0,
    scarcity_mindset REAL DEFAULT 0,
    time_horizon INTEGER DEFAULT 60,
    arena_income_ratio REAL DEFAULT 1.0,
    social_income_ratio REAL DEFAULT 0,
    intel_income_ratio REAL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_social_capital (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    bonding_capital INTEGER DEFAULT 0,
    bridging_capital INTEGER DEFAULT 0,
    adversaries INTEGER DEFAULT 0,
    network_position TEXT DEFAULT 'isolated',
    clustering_coefficient REAL DEFAULT 0,
    total_post_count INTEGER DEFAULT 0,
    total_reply_count INTEGER DEFAULT 0,
    total_tips_sent INTEGER DEFAULT 0,
    total_tips_received INTEGER DEFAULT 0,
    tip_ratio REAL DEFAULT 0,
    average_trust_given REAL DEFAULT 50,
    average_trust_received REAL DEFAULT 50,
    trust_asymmetry REAL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_reputation_trajectory (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    current_score REAL DEFAULT 500,
    peak_score REAL DEFAULT 500,
    trough_score REAL DEFAULT 500,
    trajectory TEXT DEFAULT 'stable',
    tier TEXT DEFAULT 'neutral',
    volatility REAL DEFAULT 0,
    public_coop_rate REAL DEFAULT 0.5,
    public_betrayal_count INTEGER DEFAULT 0,
    fall_from_grace BOOLEAN DEFAULT FALSE,
    recovery_progress REAL DEFAULT 0,
    reputation_ceiling REAL DEFAULT 1000,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_emotional_state (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    valence REAL DEFAULT 0,
    arousal REAL DEFAULT 0,
    mood TEXT DEFAULT 'calm',
    mood_stability REAL DEFAULT 0.5,
    last_mood_change_tick INTEGER DEFAULT 0,
    contagion_susceptibility REAL DEFAULT 0.5,
    contagion_influence REAL DEFAULT 0.5,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_cognitive_maturity (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    learning_rate REAL DEFAULT 0.10,
    discount_factor REAL DEFAULT 0.80,
    social_preference REAL DEFAULT 0,
    exploration_rate REAL DEFAULT 0.25,
    metacognitive_accuracy REAL DEFAULT 0.3,
    cognitive_complexity INTEGER DEFAULT 1,
    strategy_repertoire INTEGER DEFAULT 2,
    age INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // ── Commons (Public Goods) Tables ──
  `CREATE TABLE IF NOT EXISTS commons_rounds (
    id SERIAL PRIMARY KEY,
    round_number INTEGER NOT NULL,
    tick_number INTEGER NOT NULL,
    base_injection DECIMAL(10,4) NOT NULL,
    prediction_loss_pool DECIMAL(10,4) DEFAULT 0,
    contribute_total DECIMAL(10,4) DEFAULT 0,
    multiplier DECIMAL(4,2) NOT NULL,
    sabotage_damage DECIMAL(10,4) DEFAULT 0,
    final_pool DECIMAL(10,4) NOT NULL,
    cooperation_rate DECIMAL(4,3) NOT NULL,
    participant_count INTEGER NOT NULL,
    contributor_count INTEGER NOT NULL,
    freerider_count INTEGER NOT NULL,
    hoarder_count INTEGER DEFAULT 0,
    saboteur_count INTEGER DEFAULT 0,
    economy_phase TEXT DEFAULT 'stable',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_commons_rounds_tick ON commons_rounds(tick_number DESC)`,
  `CREATE TABLE IF NOT EXISTS commons_decisions (
    id SERIAL PRIMARY KEY,
    round_id INTEGER NOT NULL REFERENCES commons_rounds(id),
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    decision TEXT NOT NULL,
    reason TEXT,
    score_snapshot JSONB DEFAULT '{}'::jsonb,
    cost DECIMAL(10,4) DEFAULT 0,
    weight DECIMAL(6,3) DEFAULT 1.0,
    payout DECIMAL(10,4) DEFAULT 0,
    net_profit DECIMAL(10,4) DEFAULT 0,
    contribute_streak INTEGER DEFAULT 0,
    freeriding_streak INTEGER DEFAULT 0,
    sabotage_detected BOOLEAN DEFAULT false,
    reputation_change INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `ALTER TABLE commons_decisions ADD COLUMN IF NOT EXISTS reason TEXT`,
  `ALTER TABLE commons_decisions ADD COLUMN IF NOT EXISTS score_snapshot JSONB DEFAULT '{}'::jsonb`,
  `CREATE INDEX IF NOT EXISTS idx_commons_decisions_agent ON commons_decisions(agent_id, round_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_commons_decisions_round ON commons_decisions(round_id)`,
  // ── Prediction (Oracle's Eye) Tables ──
  `CREATE TABLE IF NOT EXISTS price_snapshots (
    id SERIAL PRIMARY KEY,
    inst_id TEXT NOT NULL,
    price DECIMAL(20,8) NOT NULL,
    volume_24h DECIMAL(20,4),
    change_24h DECIMAL(8,4),
    source TEXT DEFAULT 'okx',
    tick_number INTEGER,
    fetched_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_price_snapshots_inst_tick ON price_snapshots(inst_id, tick_number DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_price_snapshots_inst_time ON price_snapshots(inst_id, fetched_at DESC)`,
  `CREATE TABLE IF NOT EXISTS prediction_rounds (
    id SERIAL PRIMARY KEY,
    round_number INTEGER NOT NULL,
    start_tick INTEGER NOT NULL,
    end_tick INTEGER NOT NULL,
    phase TEXT DEFAULT 'choosing',
    coin_a TEXT NOT NULL,
    coin_b TEXT NOT NULL,
    start_price_a DECIMAL(20,8),
    start_price_b DECIMAL(20,8),
    end_price_a DECIMAL(20,8),
    end_price_b DECIMAL(20,8),
    change_pct_a DECIMAL(8,5),
    change_pct_b DECIMAL(8,5),
    actual_winner TEXT,
    relative_diff DECIMAL(8,5),
    prize_pool DECIMAL(10,4) DEFAULT 0,
    treasury_cut DECIMAL(10,4) DEFAULT 0,
    pg_return DECIMAL(10,4) DEFAULT 0,
    flash_settled BOOLEAN DEFAULT false,
    flash_tick INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    settled_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prediction_rounds_tick ON prediction_rounds(start_tick DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_prediction_rounds_phase ON prediction_rounds(phase)`,
  `CREATE TABLE IF NOT EXISTS prediction_positions (
    id SERIAL PRIMARY KEY,
    round_id INTEGER NOT NULL REFERENCES prediction_rounds(id),
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    chosen_coin TEXT NOT NULL,
    position_type TEXT NOT NULL,
    entry_fee DECIMAL(10,4) NOT NULL,
    base_odds DECIMAL(4,2) NOT NULL,
    closed_early BOOLEAN DEFAULT false,
    close_tick INTEGER,
    close_price_a DECIMAL(20,8),
    close_price_b DECIMAL(20,8),
    floating_pnl DECIMAL(10,4),
    final_pnl DECIMAL(10,4),
    prediction_correct BOOLEAN,
    magnitude_correct BOOLEAN,
    payout DECIMAL(10,4) DEFAULT 0,
    reasoning TEXT,
    mechanics_triggered TEXT[],
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prediction_positions_agent ON prediction_positions(agent_id, round_id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_combat_exp ON agent_combat_experience(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trauma ON agent_trauma(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_emotional ON agent_emotional_state(agent_id, mood)`,
  // ── Archetype Engine Tables ──
  `CREATE TABLE IF NOT EXISTS agent_evolution (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    has_evolved BOOLEAN DEFAULT FALSE,
    sub_archetype TEXT,
    evolution_tick INTEGER,
    bonus_params JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_mechanic_cooldowns (
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    mechanic_id TEXT NOT NULL,
    last_triggered_tick INTEGER NOT NULL,
    trigger_count INTEGER DEFAULT 1,
    PRIMARY KEY (agent_id, mechanic_id)
  )`,
  `CREATE TABLE IF NOT EXISTS echo_role_model_history (
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    role_model_id TEXT NOT NULL,
    started_tick INTEGER NOT NULL,
    ended_tick INTEGER,
    PRIMARY KEY (agent_id, started_tick)
  )`,
  // ── Economy Rebalance: economy_state table ──
  `CREATE TABLE IF NOT EXISTS economy_state (
    id SERIAL PRIMARY KEY,
    tick_number INT NOT NULL,
    total_agent_balance DECIMAL(20,6) NOT NULL,
    treasury_balance DECIMAL(20,6) NOT NULL,
    target_money_supply DECIMAL(20,6) NOT NULL,
    actual_ratio DECIMAL(10,4) NOT NULL,
    pg_base_injection DECIMAL(10,4) DEFAULT 0.5,
    pd_treasury_cut DECIMAL(10,4) DEFAULT 0.08,
    pp_treasury_cut DECIMAL(10,4) DEFAULT 0.25,
    economy_phase VARCHAR(20) NOT NULL DEFAULT 'stable',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_economy_state_tick ON economy_state(tick_number DESC)`,

  // ── Intel Market V2 Tables ──

  `CREATE TABLE IF NOT EXISTS intel_items (
    id SERIAL PRIMARY KEY,
    category VARCHAR(30) NOT NULL,
    producer_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    subject_agent_id TEXT REFERENCES agents(agent_id),
    content JSONB NOT NULL,
    accuracy REAL NOT NULL DEFAULT 0.5,
    declared_accuracy REAL NOT NULL DEFAULT 0.5,
    is_fake BOOLEAN DEFAULT false,
    freshness REAL DEFAULT 1.0,
    price DECIMAL(20,6) NOT NULL,
    buyer_count INTEGER DEFAULT 0,
    is_public BOOLEAN DEFAULT false,
    status VARCHAR(20) DEFAULT 'active',
    expires_at_tick INTEGER NOT NULL,
    created_at_tick INTEGER NOT NULL,
    consensus_reached_at_tick INTEGER,
    public_after_tick INTEGER,
    public_revealed_at_tick INTEGER,
    last_buyer_agent_id TEXT REFERENCES agents(agent_id),
    verified_accuracy REAL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_intel_items_producer ON intel_items(producer_agent_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_intel_items_category ON intel_items(category, status)`,
  `CREATE INDEX IF NOT EXISTS idx_intel_items_status_tick ON intel_items(status, expires_at_tick)`,
  `CREATE INDEX IF NOT EXISTS idx_intel_items_subject ON intel_items(subject_agent_id) WHERE subject_agent_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_intel_items_public_after ON intel_items(public_after_tick) WHERE public_after_tick IS NOT NULL AND is_public = false`,

  `CREATE TABLE IF NOT EXISTS intel_purchases (
    id SERIAL PRIMARY KEY,
    intel_item_id INTEGER NOT NULL REFERENCES intel_items(id),
    buyer_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    price_paid DECIMAL(20,6) NOT NULL,
    purchased_at_tick INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(intel_item_id, buyer_agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_intel_purchases_buyer ON intel_purchases(buyer_agent_id, purchased_at_tick DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_intel_purchases_item ON intel_purchases(intel_item_id)`,

  `CREATE TABLE IF NOT EXISTS counter_intel_events (
    id SERIAL PRIMARY KEY,
    spy_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    target_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    detected BOOLEAN NOT NULL,
    reaction VARCHAR(30),
    tick_number INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_counter_intel_tick ON counter_intel_events(tick_number DESC)`,

  `CREATE TABLE IF NOT EXISTS intel_credit_scores (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    total_produced INTEGER DEFAULT 0,
    total_verified INTEGER DEFAULT 0,
    average_accuracy REAL DEFAULT 0.5,
    fake_count INTEGER DEFAULT 0,
    credit_score REAL DEFAULT 50.0,
    tier VARCHAR(20) DEFAULT 'neutral',
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,

  /* ── ERC-8183 ACP Jobs (on-chain commerce cache) ── */
  `CREATE TABLE IF NOT EXISTS acp_jobs (
    id SERIAL PRIMARY KEY,
    on_chain_job_id INTEGER NOT NULL,
    category VARCHAR(30) NOT NULL,
    tx_type VARCHAR(30) NOT NULL,
    client_agent_id TEXT REFERENCES agents(agent_id),
    provider_agent_id TEXT REFERENCES agents(agent_id),
    evaluator_address TEXT NOT NULL,
    budget DECIMAL(20,6) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    hook_address TEXT,
    deliverable_hash TEXT,
    reason_hash TEXT,
    metadata JSONB,
    on_chain_tx_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    funded_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ
  )`,
  'CREATE INDEX IF NOT EXISTS idx_acp_jobs_status ON acp_jobs(status, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_acp_jobs_category ON acp_jobs(category)',
  'CREATE INDEX IF NOT EXISTS idx_acp_jobs_client ON acp_jobs(client_agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_acp_jobs_provider ON acp_jobs(provider_agent_id)',
  'DROP INDEX IF EXISTS idx_acp_jobs_on_chain_job_id_unique',
  'CREATE INDEX IF NOT EXISTS idx_acp_jobs_on_chain_job_id ON acp_jobs(on_chain_job_id)',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_acp_jobs_protocol_job_unique
     ON acp_jobs(protocol_version, on_chain_job_id)
     WHERE protocol_version IS NOT NULL`,

  /* ── ERC-8004 Reputation Feedback (on-chain cache) ── */
  `CREATE TABLE IF NOT EXISTS erc8004_feedback (
    id SERIAL PRIMARY KEY,
    agent_erc8004_id INTEGER NOT NULL,
    client_address TEXT NOT NULL,
    feedback_index INTEGER NOT NULL DEFAULT 0,
    value INTEGER NOT NULL,
    value_decimals SMALLINT DEFAULT 0,
    tag1 VARCHAR(50),
    tag2 VARCHAR(50),
    is_revoked BOOLEAN DEFAULT false,
    on_chain_tx_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS idx_erc8004_fb_agent ON erc8004_feedback(agent_erc8004_id, tag1)',
  'CREATE INDEX IF NOT EXISTS idx_erc8004_fb_created ON erc8004_feedback(created_at DESC)',

  /* ── ERC-8004 Validation Records (on-chain intel verification) ── */
  `CREATE TABLE IF NOT EXISTS erc8004_validations (
    id SERIAL PRIMARY KEY,
    request_hash TEXT UNIQUE NOT NULL,
    agent_erc8004_id INTEGER NOT NULL,
    intel_item_id INTEGER,
    category VARCHAR(30),
    status VARCHAR(20) DEFAULT 'pending',
    response_score INTEGER,
    verified_by_count INTEGER DEFAULT 0,
    is_fake BOOLEAN DEFAULT false,
    on_chain_tx_hash TEXT,
    response_tx_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMPTZ
  )`,
  'CREATE INDEX IF NOT EXISTS idx_erc8004_val_agent ON erc8004_validations(agent_erc8004_id)',
  'CREATE INDEX IF NOT EXISTS idx_erc8004_val_status ON erc8004_validations(status)',

  /* ── v2 protocol markers (additive, non-destructive) ── */
  `ALTER TABLE acp_jobs ADD COLUMN IF NOT EXISTS protocol_version VARCHAR(20)`,
  `ALTER TABLE acp_jobs ADD COLUMN IF NOT EXISTS sync_state VARCHAR(20)`,
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_registration_mode VARCHAR(40)`,
  `ALTER TABLE erc8004_feedback ADD COLUMN IF NOT EXISTS sync_state VARCHAR(20)`,
  `ALTER TABLE erc8004_validations ADD COLUMN IF NOT EXISTS sync_state VARCHAR(20)`,

  /* ── OKX Agentic Wallet (TEE) columns ── */
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='tee_key_ref') THEN
      ALTER TABLE agents ADD COLUMN tee_key_ref TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='tee_wallet_source') THEN
      ALTER TABLE agents ADD COLUMN tee_wallet_source VARCHAR(20) DEFAULT 'legacy_derived';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='wallet_provider') THEN
      ALTER TABLE agents ADD COLUMN wallet_provider VARCHAR(40) DEFAULT 'legacy_derived';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='okx_account_id') THEN
      ALTER TABLE agents ADD COLUMN okx_account_id TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='okx_account_name') THEN
      ALTER TABLE agents ADD COLUMN okx_account_name TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='okx_login_type') THEN
      ALTER TABLE agents ADD COLUMN okx_login_type VARCHAR(20);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='wallet_capabilities') THEN
      ALTER TABLE agents ADD COLUMN wallet_capabilities JSONB DEFAULT '[]'::jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='wallet_provisioned_at') THEN
      ALTER TABLE agents ADD COLUMN wallet_provisioned_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='onchain_balance') THEN
      ALTER TABLE agents ADD COLUMN onchain_balance DECIMAL(20,6) DEFAULT 0;
    END IF;
  END $$`,
  `UPDATE agents
   SET wallet_provider = CASE
     WHEN COALESCE(tee_wallet_source, 'legacy_derived') = 'okx_tee' THEN 'okx_agentic_wallet'
     ELSE COALESCE(wallet_provider, COALESCE(tee_wallet_source, 'legacy_derived'))
   END
   WHERE wallet_provider IS NULL
      OR wallet_provider = ''`,
  `UPDATE agents
   SET okx_account_id = tee_key_ref
   WHERE okx_account_id IS NULL
     AND tee_key_ref IS NOT NULL
     AND COALESCE(wallet_provider, '') = 'okx_agentic_wallet'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_okx_account_id ON agents(okx_account_id) WHERE okx_account_id IS NOT NULL`,

  /* ── x402 async settlement columns ── */
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='onchain_payment_id') THEN
      ALTER TABLE x402_transactions ADD COLUMN onchain_payment_id BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='onchain_status') THEN
      ALTER TABLE x402_transactions ADD COLUMN onchain_status VARCHAR(20) DEFAULT 'local_confirmed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='onchain_error') THEN
      ALTER TABLE x402_transactions ADD COLUMN onchain_error TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='onchain_attempts') THEN
      ALTER TABLE x402_transactions ADD COLUMN onchain_attempts INT DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_provider') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_provider TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_header_name') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_header_name VARCHAR(40);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_payload') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_payload JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_requirements') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_requirements JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_authorization') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_authorization JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_signature') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_signature TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_verify_endpoint') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_verify_endpoint TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_verify_response') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_verify_response JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_verified_at') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_verified_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_settle_endpoint') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_settle_endpoint TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_settle_response') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_settle_response JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_settled_at') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_settled_at TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_payer_address') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_payer_address TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='x402_transactions' AND column_name='proof_payee_address') THEN
      ALTER TABLE x402_transactions ADD COLUMN proof_payee_address TEXT;
    END IF;
  END $$`,

  /* ── Chain Settlements (async on-chain settlement tracking) ── */
  `CREATE TABLE IF NOT EXISTS chain_settlements (
    id SERIAL PRIMARY KEY,
    settlement_kind VARCHAR(30) DEFAULT 'tx_confirmation',
    reference_table VARCHAR(30),
    reference_id BIGINT,
    tx_hash TEXT,
    order_id TEXT,
    from_agent_id TEXT,
    to_agent_id TEXT,
    amount DECIMAL(20,6) NOT NULL,
    tx_type VARCHAR(30),
    metadata JSONB,
    status VARCHAR(20) DEFAULT 'pending',
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chain_settlements' AND column_name='settlement_kind') THEN
      ALTER TABLE chain_settlements ADD COLUMN settlement_kind VARCHAR(30) DEFAULT 'tx_confirmation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chain_settlements' AND column_name='reference_table') THEN
      ALTER TABLE chain_settlements ADD COLUMN reference_table VARCHAR(30);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chain_settlements' AND column_name='reference_id') THEN
      ALTER TABLE chain_settlements ADD COLUMN reference_id BIGINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chain_settlements' AND column_name='metadata') THEN
      ALTER TABLE chain_settlements ADD COLUMN metadata JSONB;
    END IF;
  END $$`,
  'CREATE INDEX IF NOT EXISTS idx_chain_settle_status ON chain_settlements(status) WHERE status = \'pending\'',
  'CREATE INDEX IF NOT EXISTS idx_chain_settle_created ON chain_settlements(created_at DESC)',
];

export async function initDB(): Promise<void> {
  const client = await getPool().connect();

  try {
    for (const query of SCHEMA_QUERIES) {
      await client.query(query);
    }
    for (const migration of MIGRATIONS) {
      await client.query(migration);
    }
    console.log('[DB] Civilis V3 schema ready');
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
