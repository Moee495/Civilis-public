import { getPool } from '../db/postgres.js';
import { isWorldSignalEngineEnabled } from './config.js';

export interface WorldEventRunRecord {
  id: number;
  tickNumber: number;
  engineName: string;
  candidateType: string | null;
  status: string;
  reason: string | null;
  signalRefs: number[];
  eventId: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export async function recordWorldEventRun(input: {
  tickNumber: number;
  engineName: string;
  candidateType?: string | null;
  status: string;
  reason?: string | null;
  signalRefs?: number[];
  eventId?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<WorldEventRunRecord | null> {
  if (!isWorldSignalEngineEnabled()) {
    return null;
  }

  const pool = getPool();
  const result = await pool.query<{
    id: number;
    tick_number: number;
    engine_name: string;
    candidate_type: string | null;
    status: string;
    reason: string | null;
    signal_refs: number[] | null;
    event_id: number | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>(
    `INSERT INTO world_event_runs
      (tick_number, engine_name, candidate_type, status, reason, signal_refs, event_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, tick_number, engine_name, candidate_type, status, reason, signal_refs, event_id, metadata, created_at`,
    [
      input.tickNumber,
      input.engineName,
      input.candidateType ?? null,
      input.status,
      input.reason ?? null,
      JSON.stringify(input.signalRefs ?? []),
      input.eventId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  const row = result.rows[0];
  return {
    id: row.id,
    tickNumber: row.tick_number,
    engineName: row.engine_name,
    candidateType: row.candidate_type,
    status: row.status,
    reason: row.reason,
    signalRefs: row.signal_refs ?? [],
    eventId: row.event_id,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

export async function getLatestWorldEventEvaluationTick(): Promise<number | null> {
  const pool = getPool();
  const result = await pool.query<{ tick_number: number | null }>(
    'SELECT MAX(tick_number) AS tick_number FROM world_event_runs',
  );
  return result.rows[0]?.tick_number ?? null;
}
