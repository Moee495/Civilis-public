import { getPool } from '../db/postgres.js';
import { isWorldSignalEngineEnabled } from './config.js';

export interface WorldTickRunRecord {
  id: number;
  tickNumber: number;
  status: string;
  signalCount: number;
  eventCount: number;
  primaryEventId: number | null;
  snapshotTick: number | null;
  snapshotPersisted: boolean;
  worldRegime: string | null;
  signalsWrittenAt: string | null;
  eventsWrittenAt: string | null;
  snapshotWrittenAt: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  phaseStatus: {
    signalPhaseCompleted: boolean;
    eventPhaseCompleted: boolean;
    snapshotPhaseCompleted: boolean;
    failurePhase: 'signal_phase' | 'event_phase' | 'snapshot_phase' | null;
  };
  startedAt: string;
  completedAt: string | null;
}

interface WorldTickRunRow {
  id: number;
  tick_number: number;
  status: string;
  signal_count: number;
  event_count: number;
  primary_event_id: number | null;
  snapshot_tick: number | null;
  snapshot_persisted: boolean;
  world_regime: string | null;
  signals_written_at: string | null;
  events_written_at: string | null;
  snapshot_written_at: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  started_at: string;
  completed_at: string | null;
}

function deriveFailurePhase(row: WorldTickRunRow): 'signal_phase' | 'event_phase' | 'snapshot_phase' | null {
  if (row.status !== 'failed') {
    return null;
  }

  if (!row.signals_written_at) {
    return 'signal_phase';
  }

  if (!row.events_written_at) {
    return 'event_phase';
  }

  if (!row.snapshot_written_at || !row.snapshot_persisted) {
    return 'snapshot_phase';
  }

  return null;
}

function mapWorldTickRun(row: WorldTickRunRow | undefined): WorldTickRunRecord | null {
  if (!row) {
    return null;
  }

  const signalPhaseCompleted = Boolean(row.signals_written_at);
  const eventPhaseCompleted = Boolean(row.events_written_at);
  const snapshotPhaseCompleted = Boolean(row.snapshot_written_at && row.snapshot_persisted);

  return {
    id: row.id,
    tickNumber: row.tick_number,
    status: row.status,
    signalCount: row.signal_count,
    eventCount: row.event_count,
    primaryEventId: row.primary_event_id,
    snapshotTick: row.snapshot_tick,
    snapshotPersisted: row.snapshot_persisted,
    worldRegime: row.world_regime,
    signalsWrittenAt: row.signals_written_at,
    eventsWrittenAt: row.events_written_at,
    snapshotWrittenAt: row.snapshot_written_at,
    error: row.error,
    metadata: row.metadata ?? {},
    phaseStatus: {
      signalPhaseCompleted,
      eventPhaseCompleted,
      snapshotPhaseCompleted,
      failurePhase: deriveFailurePhase(row),
    },
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function startWorldTickRun(input: {
  tickNumber: number;
  worldRegime?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<WorldTickRunRecord | null> {
  if (!isWorldSignalEngineEnabled()) {
    return null;
  }

  const pool = getPool();
  const result = await pool.query<WorldTickRunRow>(
    `INSERT INTO world_tick_runs
      (tick_number, status, world_regime, metadata)
     VALUES ($1, 'started', $2, $3)
     RETURNING
       id,
       tick_number,
       status,
       signal_count,
       event_count,
       primary_event_id,
       snapshot_tick,
       snapshot_persisted,
       world_regime,
       signals_written_at,
       events_written_at,
       snapshot_written_at,
       error,
       metadata,
       started_at,
       completed_at`,
    [
      input.tickNumber,
      input.worldRegime ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  return mapWorldTickRun(result.rows[0]);
}

export async function completeWorldTickRun(
  tickRunId: number,
  input: {
    signalCount: number;
    eventCount: number;
    primaryEventId?: number | null;
    snapshotTick?: number | null;
    worldRegime?: string | null;
    signalsWrittenAt?: string | null;
    eventsWrittenAt?: string | null;
    snapshotWrittenAt?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<WorldTickRunRecord | null> {
  if (!isWorldSignalEngineEnabled()) {
    return null;
  }

  const pool = getPool();
  const result = await pool.query<WorldTickRunRow>(
    `UPDATE world_tick_runs
     SET
       status = 'completed',
       signal_count = $2,
       event_count = $3,
       primary_event_id = $4,
       snapshot_tick = $5,
       snapshot_persisted = true,
       world_regime = COALESCE($6, world_regime),
       signals_written_at = COALESCE($7, signals_written_at),
       events_written_at = COALESCE($8, events_written_at),
       snapshot_written_at = COALESCE($9, snapshot_written_at, CURRENT_TIMESTAMP),
       metadata = $10,
       error = NULL,
       completed_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING
       id,
       tick_number,
       status,
       signal_count,
       event_count,
       primary_event_id,
       snapshot_tick,
       snapshot_persisted,
       world_regime,
       signals_written_at,
       events_written_at,
       snapshot_written_at,
       error,
       metadata,
       started_at,
       completed_at`,
    [
      tickRunId,
      input.signalCount,
      input.eventCount,
      input.primaryEventId ?? null,
      input.snapshotTick ?? null,
      input.worldRegime ?? null,
      input.signalsWrittenAt ?? null,
      input.eventsWrittenAt ?? null,
      input.snapshotWrittenAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  return mapWorldTickRun(result.rows[0]);
}

export async function failWorldTickRun(
  tickRunId: number,
  input: {
    signalCount?: number;
    eventCount?: number;
    primaryEventId?: number | null;
    snapshotTick?: number | null;
    snapshotPersisted?: boolean;
    worldRegime?: string | null;
    signalsWrittenAt?: string | null;
    eventsWrittenAt?: string | null;
    snapshotWrittenAt?: string | null;
    error?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<WorldTickRunRecord | null> {
  if (!isWorldSignalEngineEnabled()) {
    return null;
  }

  const pool = getPool();
  const result = await pool.query<WorldTickRunRow>(
    `UPDATE world_tick_runs
     SET
       status = 'failed',
       signal_count = COALESCE($2, signal_count),
       event_count = COALESCE($3, event_count),
       primary_event_id = COALESCE($4, primary_event_id),
       snapshot_tick = COALESCE($5, snapshot_tick),
       snapshot_persisted = COALESCE($6, snapshot_persisted),
       world_regime = COALESCE($7, world_regime),
       signals_written_at = COALESCE($8, signals_written_at),
       events_written_at = COALESCE($9, events_written_at),
       snapshot_written_at = COALESCE($10, snapshot_written_at),
       error = COALESCE($11, error),
       metadata = $12,
       completed_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING
       id,
       tick_number,
       status,
       signal_count,
       event_count,
       primary_event_id,
       snapshot_tick,
       snapshot_persisted,
       world_regime,
       signals_written_at,
       events_written_at,
       snapshot_written_at,
       error,
       metadata,
       started_at,
       completed_at`,
    [
      tickRunId,
      input.signalCount ?? null,
      input.eventCount ?? null,
      input.primaryEventId ?? null,
      input.snapshotTick ?? null,
      input.snapshotPersisted ?? null,
      input.worldRegime ?? null,
      input.signalsWrittenAt ?? null,
      input.eventsWrittenAt ?? null,
      input.snapshotWrittenAt ?? null,
      input.error ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  return mapWorldTickRun(result.rows[0]);
}

export async function getLatestWorldTickRun(): Promise<WorldTickRunRecord | null> {
  const pool = getPool();
  const result = await pool.query<WorldTickRunRow>(
    `SELECT
       id,
       tick_number,
       status,
       signal_count,
       event_count,
       primary_event_id,
       snapshot_tick,
       snapshot_persisted,
       world_regime,
       signals_written_at,
       events_written_at,
       snapshot_written_at,
       error,
       metadata,
       started_at,
       completed_at
     FROM world_tick_runs
     ORDER BY tick_number DESC, started_at DESC
     LIMIT 1`,
  );

  return mapWorldTickRun(result.rows[0]);
}

export async function markWorldTickRunSignalsWritten(
  tickRunId: number,
  input?: { worldRegime?: string | null; signalCount?: number },
): Promise<void> {
  if (!isWorldSignalEngineEnabled()) {
    return;
  }

  const pool = getPool();
  await pool.query(
    `UPDATE world_tick_runs
     SET
       signals_written_at = COALESCE(signals_written_at, CURRENT_TIMESTAMP),
       signal_count = COALESCE($2, signal_count),
       world_regime = COALESCE($3, world_regime),
       metadata = jsonb_set(metadata, '{phase}', to_jsonb($4::text), true)
     WHERE id = $1`,
    [tickRunId, input?.signalCount ?? null, input?.worldRegime ?? null, 'signals_written'],
  );
}

export async function markWorldTickRunEventsWritten(
  tickRunId: number,
  input?: { eventCount?: number; primaryEventId?: number | null },
): Promise<void> {
  if (!isWorldSignalEngineEnabled()) {
    return;
  }

  const pool = getPool();
  await pool.query(
    `UPDATE world_tick_runs
     SET
       events_written_at = COALESCE(events_written_at, CURRENT_TIMESTAMP),
       event_count = COALESCE($2, event_count),
       primary_event_id = COALESCE($3, primary_event_id),
       metadata = jsonb_set(metadata, '{phase}', to_jsonb($4::text), true)
     WHERE id = $1`,
    [tickRunId, input?.eventCount ?? null, input?.primaryEventId ?? null, 'events_written'],
  );
}
