import { getPool } from '../db/postgres.js';
import { eventBus } from '../realtime.js';
import { getDefaultWorldEventDuration, isWorldSignalEngineEnabled } from './config.js';
import type { WorldEventRecord } from './events.js';

export interface WorldModifierRecord {
  id: number;
  sourceEventId: number | null;
  modifierType: string;
  domain: string;
  scopeType: string;
  scopeRef: string | null;
  value: Record<string, unknown>;
  startsAtTick: number;
  endsAtTick: number | null;
  status: string;
  createdAt: string;
}

export type WorldModifierStackMode =
  | 'additive'
  | 'multiplicative'
  | 'boolean_any'
  | 'latest_numeric';

export type WorldModifierDedupeMode = 'none' | 'source_event_id' | 'scope_ref';

export interface WorldModifierStackPolicy {
  mode: WorldModifierStackMode;
  field: string;
  note: string;
  minValue?: number | null;
  maxValue?: number | null;
  maxContributors?: number | null;
  dedupeBy?: WorldModifierDedupeMode;
}

export interface WorldModifierStackSummary {
  modifierType: string;
  domain: string;
  scopeType: string;
  scopeRef: string | null;
  count: number;
  mode: WorldModifierStackMode;
  field: string;
  sourceEventIds: number[];
  contributorCountUsed: number;
  dedupeBy: WorldModifierDedupeMode;
  minValue: number | null;
  maxValue: number | null;
  maxContributors: number | null;
  effectiveValue: number | boolean | null;
  capped: boolean;
}

interface ListWorldModifiersOptions {
  status?: 'active' | 'expired';
  limit?: number;
  domain?: string;
  modifierType?: string;
  scopeType?: string;
  scopeRef?: string;
}

interface ResolveActiveWorldModifiersOptions {
  domain?: string;
  modifierType?: string;
  scopeRefs?: string[];
  includeGlobal?: boolean;
  limit?: number;
}

interface WorldModifierDescriptor {
  modifierType: string;
  domain: string;
  scopeType: string;
  scopeRef?: string | null;
  value: Record<string, unknown>;
  durationTicks: number | null;
}

const WORLD_MODIFIER_STACK_POLICIES: Record<string, WorldModifierStackPolicy> = {
  social_post_cost_multiplier: {
    mode: 'multiplicative',
    field: 'multiplier',
    note: 'Cost modifiers multiply to preserve proportional pricing shifts.',
    minValue: 0,
    maxValue: 3,
    maxContributors: 2,
    dedupeBy: 'source_event_id',
  },
  risk_tolerance_shift: {
    mode: 'additive',
    field: 'delta',
    note: 'Risk shifts sum across overlapping world events, but only the two newest contributors apply and the result is clamped.',
    minValue: -0.2,
    maxValue: 0.2,
    maxContributors: 2,
    dedupeBy: 'source_event_id',
  },
  divination_price_multiplier: {
    mode: 'multiplicative',
    field: 'multiplier',
    note: 'Fate pricing pressure compounds multiplicatively.',
    minValue: 0.5,
    maxValue: 2.5,
    maxContributors: 2,
    dedupeBy: 'source_event_id',
  },
  pd_payout_multiplier: {
    mode: 'multiplicative',
    field: 'multiplier',
    note: 'Arena payout pressure compounds multiplicatively.',
    minValue: 0.6,
    maxValue: 1.4,
    maxContributors: 2,
    dedupeBy: 'source_event_id',
  },
  commons_multiplier_bonus: {
    mode: 'additive',
    field: 'delta',
    note: 'Commons multiplier bonuses sum across active effects with a bounded aggregate range.',
    minValue: -0.3,
    maxValue: 0.3,
    maxContributors: 2,
    dedupeBy: 'source_event_id',
  },
  prediction_odds_bonus: {
    mode: 'additive',
    field: 'delta',
    note: 'Prediction odds bonuses sum across active effects with a bounded aggregate range.',
    minValue: -0.2,
    maxValue: 0.2,
    maxContributors: 2,
    dedupeBy: 'source_event_id',
  },
  commons_base_injection_override: {
    mode: 'latest_numeric',
    field: 'value',
    note: 'Base injection override follows the latest active numeric value.',
    minValue: 0,
    maxValue: 1,
    maxContributors: 1,
    dedupeBy: 'source_event_id',
  },
  forced_match_pressure: {
    mode: 'boolean_any',
    field: 'enabled',
    note: 'Any active forced-match modifier turns the pressure on.',
    maxContributors: 1,
    dedupeBy: 'source_event_id',
  },
  valence_shift: {
    mode: 'additive',
    field: 'delta',
    note: 'Emotion valence shifts sum across active effects but clamp into a bounded mood range.',
    minValue: -0.6,
    maxValue: 0.6,
    maxContributors: 2,
    dedupeBy: 'source_event_id',
  },
  arousal_shift: {
    mode: 'additive',
    field: 'delta',
    note: 'Emotion arousal shifts sum across active effects but clamp into a bounded activation range.',
    minValue: -0.4,
    maxValue: 0.4,
    maxContributors: 2,
    dedupeBy: 'source_event_id',
  },
  commons_coop_override: {
    mode: 'additive',
    field: 'delta',
    note: 'Commons cooperation overrides sum across active effects with a bounded aggregate range.',
    minValue: -0.35,
    maxValue: 0.25,
    maxContributors: 2,
    dedupeBy: 'source_event_id',
  },
  tournament_attention: {
    mode: 'boolean_any',
    field: 'matchId',
    note: 'Any active tournament-attention modifier keeps the spotlight enabled.',
    maxContributors: 1,
    dedupeBy: 'source_event_id',
  },
};

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resolveDurationTicks(event: WorldEventRecord): number | null {
  const impactDuration = asNumber(event.impact.duration) ?? asNumber(event.impact.effectDuration);
  return impactDuration ?? getDefaultWorldEventDuration(event.eventType);
}

function buildWorldModifierDescriptors(event: WorldEventRecord): WorldModifierDescriptor[] {
  const durationTicks = resolveDurationTicks(event);
  const heraldAgent = asString(event.impact.heraldAgent);
  const suspectAgent = asString(event.impact.suspectAgent);

  switch (event.eventType) {
    case 'reputation_contest': {
      const descriptors: WorldModifierDescriptor[] = [];
      if (heraldAgent) {
        descriptors.push({
          modifierType: 'social_post_cost_multiplier',
          domain: 'social',
          scopeType: 'agent',
          scopeRef: heraldAgent,
          value: { multiplier: 0, role: 'herald' },
          durationTicks,
        });
      }
      if (suspectAgent) {
        descriptors.push({
          modifierType: 'social_post_cost_multiplier',
          domain: 'social',
          scopeType: 'agent',
          scopeRef: suspectAgent,
          value: { multiplier: 2, role: 'suspect' },
          durationTicks,
        });
      }
      return descriptors;
    }
    case 'market_panic_real':
      return [
        {
          modifierType: 'risk_tolerance_shift',
          domain: 'agent_decision',
          scopeType: 'global',
          value: { delta: asNumber(event.impact.riskModifier) ?? 0.1 },
          durationTicks,
        },
      ];
    case 'mist_deepens_real':
      return [
        {
          modifierType: 'divination_price_multiplier',
          domain: 'fate',
          scopeType: 'global',
          value: { multiplier: asNumber(event.impact.divinationPriceMultiplier) ?? 2 },
          durationTicks,
        },
      ];
    case 'golden_age':
      return [
        {
          modifierType: 'pd_payout_multiplier',
          domain: 'arena',
          scopeType: 'global',
          value: { multiplier: asNumber(event.impact.pdPayoutMultiplier) ?? 1.2 },
          durationTicks,
        },
        {
          modifierType: 'commons_multiplier_bonus',
          domain: 'commons',
          scopeType: 'global',
          value: { delta: asNumber(event.impact.commonsMultiplierBonus) ?? 0.2 },
          durationTicks,
        },
        {
          modifierType: 'prediction_odds_bonus',
          domain: 'prediction',
          scopeType: 'global',
          value: { delta: asNumber(event.impact.predictionOddsBonus) ?? 0.1 },
          durationTicks,
        },
      ];
    case 'civilization_collapse':
      return [
        {
          modifierType: 'commons_base_injection_override',
          domain: 'commons',
          scopeType: 'global',
          value: { value: asNumber(event.impact.commonsBaseInjection) ?? 0 },
          durationTicks,
        },
        {
          modifierType: 'pd_payout_multiplier',
          domain: 'arena',
          scopeType: 'global',
          value: { multiplier: asNumber(event.impact.pdPayoutMultiplier) ?? 0.7 },
          durationTicks,
        },
        {
          modifierType: 'forced_match_pressure',
          domain: 'arena',
          scopeType: 'global',
          value: { enabled: Boolean(event.impact.forceTriplePD) },
          durationTicks,
        },
      ];
    case 'bubble_burst':
      return [
        {
          modifierType: 'valence_shift',
          domain: 'emotion',
          scopeType: 'global',
          value: { delta: asNumber(event.impact.allAgentValence) ?? -0.5 },
          durationTicks,
        },
        {
          modifierType: 'commons_coop_override',
          domain: 'commons',
          scopeType: 'global',
          value: { delta: asNumber(event.impact.commonsCoopRateOverride) ?? -0.2 },
          durationTicks,
        },
      ];
    case 'lost_beacon':
      return [
        {
          modifierType: 'valence_shift',
          domain: 'emotion',
          scopeType: 'global',
          value: { delta: asNumber(event.impact.allAgentValence) ?? -0.3 },
          durationTicks,
        },
        {
          modifierType: 'arousal_shift',
          domain: 'emotion',
          scopeType: 'global',
          value: { delta: asNumber(event.impact.allAgentArousal) ?? 0.2 },
          durationTicks,
        },
        {
          modifierType: 'commons_coop_override',
          domain: 'commons',
          scopeType: 'global',
          value: { delta: asNumber(event.impact.commonsCoopRateOverride) ?? -0.15 },
          durationTicks,
        },
      ];
    case 'tournament':
      return [
        {
          modifierType: 'tournament_attention',
          domain: 'arena',
          scopeType: 'global',
          value: { matchId: event.impact.matchId ?? null },
          durationTicks,
        },
      ];
    default:
      return [];
  }
}

export async function syncWorldModifiersForEvent(
  event: WorldEventRecord,
  tick: number,
): Promise<WorldModifierRecord[]> {
  if (!isWorldSignalEngineEnabled()) {
    return [];
  }

  const descriptors = buildWorldModifierDescriptors(event);
  if (descriptors.length === 0) {
    return [];
  }

  const pool = getPool();
  const created: WorldModifierRecord[] = [];

  for (const descriptor of descriptors) {
    const endsAtTick =
      descriptor.durationTicks != null ? tick + descriptor.durationTicks : event.endsAtTick;
    const result = await pool.query<{
      id: number;
      source_event_id: number | null;
      modifier_type: string;
      domain: string;
      scope_type: string;
      scope_ref: string | null;
      value: Record<string, unknown>;
      starts_at_tick: number;
      ends_at_tick: number | null;
      status: string;
      created_at: string;
    }>(
      `INSERT INTO world_modifiers
        (source_event_id, modifier_type, domain, scope_type, scope_ref, value, starts_at_tick, ends_at_tick, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
       RETURNING id, source_event_id, modifier_type, domain, scope_type, scope_ref, value, starts_at_tick, ends_at_tick, status, created_at`,
      [
        event.id,
        descriptor.modifierType,
        descriptor.domain,
        descriptor.scopeType,
        descriptor.scopeRef ?? null,
        JSON.stringify(descriptor.value),
        tick,
        endsAtTick,
      ],
    );

    const row = result.rows[0];
    created.push({
      id: row.id,
      sourceEventId: row.source_event_id,
      modifierType: row.modifier_type,
      domain: row.domain,
      scopeType: row.scope_type,
      scopeRef: row.scope_ref,
      value: row.value ?? {},
      startsAtTick: row.starts_at_tick,
      endsAtTick: row.ends_at_tick,
      status: row.status,
      createdAt: row.created_at,
    });

    eventBus.emit('world_modifier_started', {
      sourceEventId: row.source_event_id,
      modifierType: row.modifier_type,
      domain: row.domain,
      scopeType: row.scope_type,
      scopeRef: row.scope_ref,
      endsAtTick: row.ends_at_tick,
    });
  }

  await pool.query(
    `UPDATE world_events
     SET status = 'active'
     WHERE id = $1`,
    [event.id],
  );

  return created;
}

export async function expireWorldModifiers(tick: number): Promise<WorldModifierRecord[]> {
  if (!isWorldSignalEngineEnabled()) {
    return [];
  }

  const pool = getPool();
  const result = await pool.query<{
    id: number;
    source_event_id: number | null;
    modifier_type: string;
    domain: string;
    scope_type: string;
    scope_ref: string | null;
    value: Record<string, unknown>;
    starts_at_tick: number;
    ends_at_tick: number | null;
    status: string;
    created_at: string;
  }>(
    `UPDATE world_modifiers
     SET status = 'expired'
     WHERE status = 'active'
       AND ends_at_tick IS NOT NULL
       AND ends_at_tick < $1
     RETURNING id, source_event_id, modifier_type, domain, scope_type, scope_ref, value, starts_at_tick, ends_at_tick, status, created_at`,
    [tick],
  );

  if (result.rows.length > 0) {
    const sourceEventIds = Array.from(
      new Set(result.rows.map((row) => row.source_event_id).filter((value): value is number => value != null)),
    );

    if (sourceEventIds.length > 0) {
      await pool.query(
        `UPDATE world_events
         SET status = 'expired'
         WHERE id = ANY($1::int[])
           AND NOT EXISTS (
             SELECT 1
             FROM world_modifiers
             WHERE world_modifiers.source_event_id = world_events.id
               AND world_modifiers.status = 'active'
           )`,
        [sourceEventIds],
      );
    }
  }

  const expired = result.rows.map((row) => ({
    id: row.id,
    sourceEventId: row.source_event_id,
    modifierType: row.modifier_type,
    domain: row.domain,
    scopeType: row.scope_type,
    scopeRef: row.scope_ref,
    value: row.value ?? {},
    startsAtTick: row.starts_at_tick,
    endsAtTick: row.ends_at_tick,
    status: row.status,
    createdAt: row.created_at,
  }));

  for (const modifier of expired) {
    eventBus.emit('world_modifier_expired', {
      sourceEventId: modifier.sourceEventId,
      modifierType: modifier.modifierType,
      domain: modifier.domain,
      scopeType: modifier.scopeType,
      scopeRef: modifier.scopeRef,
      endsAtTick: modifier.endsAtTick,
    });
  }

  return expired;
}

export async function listWorldModifiers(options?: {
  status?: 'active' | 'expired';
  limit?: number;
  domain?: string;
  modifierType?: string;
  scopeType?: string;
  scopeRef?: string;
}): Promise<WorldModifierRecord[]> {
  const pool = getPool();
  const status = options?.status ?? 'active';
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = ['status = $1'];
  const params: Array<string | number> = [status];

  if (options?.domain) {
    params.push(options.domain);
    conditions.push(`domain = $${params.length}`);
  }

  if (options?.modifierType) {
    params.push(options.modifierType);
    conditions.push(`modifier_type = $${params.length}`);
  }

  if (options?.scopeType) {
    params.push(options.scopeType);
    conditions.push(`scope_type = $${params.length}`);
  }

  if (options?.scopeRef) {
    params.push(options.scopeRef);
    conditions.push(`scope_ref = $${params.length}`);
  }

  params.push(limit);
  const result = await pool.query<{
    id: number;
    source_event_id: number | null;
    modifier_type: string;
    domain: string;
    scope_type: string;
    scope_ref: string | null;
    value: Record<string, unknown>;
    starts_at_tick: number;
    ends_at_tick: number | null;
    status: string;
    created_at: string;
  }>(
    `SELECT id, source_event_id, modifier_type, domain, scope_type, scope_ref, value, starts_at_tick, ends_at_tick, status, created_at
     FROM world_modifiers
     WHERE ${conditions.join(' AND ')}
     ORDER BY starts_at_tick DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    sourceEventId: row.source_event_id,
    modifierType: row.modifier_type,
    domain: row.domain,
    scopeType: row.scope_type,
    scopeRef: row.scope_ref,
    value: row.value ?? {},
    startsAtTick: row.starts_at_tick,
    endsAtTick: row.ends_at_tick,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export async function resolveActiveWorldModifiers(
  options?: ResolveActiveWorldModifiersOptions,
): Promise<WorldModifierRecord[]> {
  const pool = getPool();
  const limit = Math.min(options?.limit ?? 100, 250);
  const conditions = [`status = 'active'`];
  const params: Array<string | number | string[]> = [];

  if (options?.domain) {
    params.push(options.domain);
    conditions.push(`domain = $${params.length}`);
  }

  if (options?.modifierType) {
    params.push(options.modifierType);
    conditions.push(`modifier_type = $${params.length}`);
  }

  const scopeRefs = (options?.scopeRefs ?? []).filter((value): value is string => Boolean(value));
  const includeGlobal = options?.includeGlobal ?? true;
  if (scopeRefs.length > 0) {
    params.push(scopeRefs);
    const refParam = `$${params.length}::text[]`;
    conditions.push(
      includeGlobal
        ? `(scope_type = 'global' OR scope_ref = ANY(${refParam}))`
        : `scope_ref = ANY(${refParam})`,
    );
  } else if (!includeGlobal) {
    conditions.push(`scope_type <> 'global'`);
  }

  params.push(limit);
  const result = await pool.query<{
    id: number;
    source_event_id: number | null;
    modifier_type: string;
    domain: string;
    scope_type: string;
    scope_ref: string | null;
    value: Record<string, unknown>;
    starts_at_tick: number;
    ends_at_tick: number | null;
    status: string;
    created_at: string;
  }>(
    `SELECT id, source_event_id, modifier_type, domain, scope_type, scope_ref, value, starts_at_tick, ends_at_tick, status, created_at
     FROM world_modifiers
     WHERE ${conditions.join(' AND ')}
     ORDER BY starts_at_tick DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    id: row.id,
    sourceEventId: row.source_event_id,
    modifierType: row.modifier_type,
    domain: row.domain,
    scopeType: row.scope_type,
    scopeRef: row.scope_ref,
    value: row.value ?? {},
    startsAtTick: row.starts_at_tick,
    endsAtTick: row.ends_at_tick,
    status: row.status,
    createdAt: row.created_at,
  }));
}

function numericField(value: Record<string, unknown>, key: string): number | null {
  const raw = value[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const raw = value[key];
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'number') {
    return raw !== 0;
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'null';
  }
  return raw != null;
}

function stackSummaryKey(modifier: WorldModifierRecord): string {
  return [
    modifier.modifierType,
    modifier.domain,
    modifier.scopeType,
    modifier.scopeRef ?? 'global',
  ].join(':');
}

export function getWorldModifierStackPolicy(modifierType: string): WorldModifierStackPolicy {
  return WORLD_MODIFIER_STACK_POLICIES[modifierType] ?? {
    mode: 'additive',
    field: 'delta',
    note: 'Unknown modifiers default to additive delta semantics until a dedicated policy is defined.',
    dedupeBy: 'source_event_id',
  };
}

function clampNumericValue(
  value: number,
  policy: WorldModifierStackPolicy,
): { value: number; capped: boolean } {
  let nextValue = value;
  let capped = false;

  if (policy.minValue != null && nextValue < policy.minValue) {
    nextValue = policy.minValue;
    capped = true;
  }

  if (policy.maxValue != null && nextValue > policy.maxValue) {
    nextValue = policy.maxValue;
    capped = true;
  }

  return { value: nextValue, capped };
}

function selectPolicyContributors(
  modifiers: WorldModifierRecord[],
  policy: WorldModifierStackPolicy,
): WorldModifierRecord[] {
  const dedupeBy = policy.dedupeBy ?? 'none';
  const seen = new Set<string>();
  const selected: WorldModifierRecord[] = [];

  for (const modifier of modifiers) {
    let dedupeKey = `id:${modifier.id}`;
    if (dedupeBy === 'source_event_id') {
      dedupeKey =
        modifier.sourceEventId != null ? `source:${modifier.sourceEventId}` : `id:${modifier.id}`;
    } else if (dedupeBy === 'scope_ref') {
      dedupeKey = `scope:${modifier.scopeRef ?? 'global'}`;
    }

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    selected.push(modifier);

    if (policy.maxContributors != null && selected.length >= policy.maxContributors) {
      break;
    }
  }

  return selected;
}

function evaluateWorldModifierStack(
  modifiers: WorldModifierRecord[],
  policy: WorldModifierStackPolicy,
): {
  selected: WorldModifierRecord[];
  effectiveValue: number | boolean | null;
  capped: boolean;
} {
  const selected = selectPolicyContributors(modifiers, policy);

  if (policy.mode === 'boolean_any') {
    return {
      selected,
      effectiveValue: selected.some((modifier) => booleanField(modifier.value, policy.field)),
      capped: false,
    };
  }

  if (policy.mode === 'latest_numeric') {
    for (const modifier of selected) {
      const numeric = numericField(modifier.value, policy.field);
      if (numeric != null) {
        const bounded = clampNumericValue(numeric, policy);
        return {
          selected,
          effectiveValue: bounded.value,
          capped: bounded.capped,
        };
      }
    }

    return {
      selected,
      effectiveValue: null,
      capped: false,
    };
  }

  if (policy.mode === 'multiplicative') {
    const multiplied = selected.reduce((product, modifier) => {
      const multiplier = numericField(modifier.value, policy.field);
      return multiplier != null ? product * multiplier : product;
    }, 1);
    const bounded = clampNumericValue(multiplied, policy);
    return {
      selected,
      effectiveValue: bounded.value,
      capped: bounded.capped,
    };
  }

  const added = selected.reduce((sum, modifier) => {
    const delta = numericField(modifier.value, policy.field);
    return delta != null ? sum + delta : sum;
  }, 0);
  const bounded = clampNumericValue(added, policy);
  return {
    selected,
    effectiveValue: bounded.value,
    capped: bounded.capped,
  };
}

export function resolveWorldModifierValueFromRecords(
  modifiers: WorldModifierRecord[],
  modifierType: string,
  field?: string,
): {
  selected: WorldModifierRecord[];
  effectiveValue: number | boolean | null;
  capped: boolean;
  policy: WorldModifierStackPolicy;
} {
  const basePolicy = getWorldModifierStackPolicy(modifierType);
  const policy: WorldModifierStackPolicy = field
    ? { ...basePolicy, field }
    : basePolicy;
  const matching = modifiers.filter((modifier) => modifier.modifierType === modifierType);
  const evaluated = evaluateWorldModifierStack(matching, policy);

  return {
    selected: evaluated.selected,
    effectiveValue: evaluated.effectiveValue,
    capped: evaluated.capped,
    policy,
  };
}

export function summarizeWorldModifierStacks(
  modifiers: WorldModifierRecord[],
): WorldModifierStackSummary[] {
  const grouped = new Map<
    string,
    { summary: WorldModifierStackSummary; modifiers: WorldModifierRecord[] }
  >();

  for (const modifier of modifiers) {
    const key = stackSummaryKey(modifier);
    const policy = getWorldModifierStackPolicy(modifier.modifierType);
    const existing = grouped.get(key);

    if (existing) {
      existing.summary.count += 1;
      existing.modifiers.push(modifier);
      if (
        modifier.sourceEventId != null &&
        !existing.summary.sourceEventIds.includes(modifier.sourceEventId)
      ) {
        existing.summary.sourceEventIds.push(modifier.sourceEventId);
      }
      continue;
    }

    grouped.set(key, {
      summary: {
        modifierType: modifier.modifierType,
        domain: modifier.domain,
        scopeType: modifier.scopeType,
        scopeRef: modifier.scopeRef,
        count: 1,
        mode: policy.mode,
        field: policy.field,
        sourceEventIds: modifier.sourceEventId != null ? [modifier.sourceEventId] : [],
        contributorCountUsed: 0,
        dedupeBy: policy.dedupeBy ?? 'none',
        minValue: policy.minValue ?? null,
        maxValue: policy.maxValue ?? null,
        maxContributors: policy.maxContributors ?? null,
        effectiveValue: null,
        capped: false,
      },
      modifiers: [modifier],
    });
  }

  return Array.from(grouped.values())
    .map(({ summary, modifiers: groupedModifiers }) => {
      const policy = getWorldModifierStackPolicy(summary.modifierType);
      const evaluated = evaluateWorldModifierStack(groupedModifiers, policy);
      return {
        ...summary,
        contributorCountUsed: evaluated.selected.length,
        effectiveValue: evaluated.effectiveValue,
        capped: evaluated.capped,
      };
    })
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.modifierType.localeCompare(b.modifierType);
    });
}

export async function getWorldModifierResolvedValue(
  options: ResolveActiveWorldModifiersOptions & { field?: string },
): Promise<{
  modifiers: WorldModifierRecord[];
  selected: WorldModifierRecord[];
  effectiveValue: number | boolean | null;
  capped: boolean;
  policy: WorldModifierStackPolicy;
}> {
  const modifiers = await resolveActiveWorldModifiers(options);
  const evaluated = resolveWorldModifierValueFromRecords(
    modifiers,
    options.modifierType ?? '',
    options.field,
  );

  return {
    modifiers,
    selected: evaluated.selected,
    effectiveValue: evaluated.effectiveValue,
    capped: evaluated.capped,
    policy: evaluated.policy,
  };
}

export async function getWorldModifierMultiplier(
  options: ResolveActiveWorldModifiersOptions & { field?: string },
): Promise<number> {
  const resolved = await getWorldModifierResolvedValue(options);
  return typeof resolved.effectiveValue === 'number' ? resolved.effectiveValue : 1;
}

export async function getWorldModifierDelta(
  options: ResolveActiveWorldModifiersOptions & { field?: string },
): Promise<number> {
  const resolved = await getWorldModifierResolvedValue(options);
  return typeof resolved.effectiveValue === 'number' ? resolved.effectiveValue : 0;
}

export async function getLatestWorldModifierNumericValue(
  options: ResolveActiveWorldModifiersOptions & { field?: string },
): Promise<number | null> {
  const resolved = await getWorldModifierResolvedValue({ ...options, limit: 50 });
  return typeof resolved.effectiveValue === 'number' ? resolved.effectiveValue : null;
}

export async function hasActiveWorldModifier(
  options: ResolveActiveWorldModifiersOptions,
): Promise<boolean> {
  const resolved = await getWorldModifierResolvedValue({ ...options, limit: 10 });
  if (resolved.policy.mode === 'boolean_any') {
    return Boolean(resolved.effectiveValue);
  }
  return resolved.selected.length > 0;
}

export async function getActiveWorldModifierCount(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM world_modifiers
     WHERE status = 'active'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getActiveWorldEventCount(): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT source_event_id) AS count
     FROM world_modifiers
     WHERE status = 'active'
       AND source_event_id IS NOT NULL`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
