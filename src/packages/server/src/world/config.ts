export type WorldSignalEngineMode = 'off' | 'shadow' | 'active';

const VALID_SIGNAL_ENGINE_MODES = new Set<WorldSignalEngineMode>(['off', 'shadow', 'active']);

const DEFAULT_WORLD_EVENT_DURATIONS: Record<string, number> = {
  reputation_contest: 10,
  market_panic_real: 10,
  mist_deepens_real: 10,
  golden_age: 20,
  civilization_collapse: 15,
  bubble_burst: 10,
  lost_beacon: 10,
  tournament: 5,
};

export function getWorldSignalEngineMode(): WorldSignalEngineMode {
  const raw = (process.env.WORLD_EVENT_SIGNAL_ENGINE ?? 'shadow').toLowerCase();
  return VALID_SIGNAL_ENGINE_MODES.has(raw as WorldSignalEngineMode)
    ? (raw as WorldSignalEngineMode)
    : 'shadow';
}

export function isWorldSignalEngineEnabled(): boolean {
  return getWorldSignalEngineMode() !== 'off';
}

export function getDefaultWorldEventDuration(eventType: string): number | null {
  return DEFAULT_WORLD_EVENT_DURATIONS[eventType] ?? null;
}
