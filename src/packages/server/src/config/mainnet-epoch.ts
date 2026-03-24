import { getXLayerNetwork } from './xlayer.js';

export interface MainnetEpochConfig {
  enabled: boolean;
  startAtIso: string | null;
  startTick: number | null;
}

type EpochParam = string | number;

function parseEpochStartAt(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function parseEpochStartTick(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.floor(parsed);
}

export function getMainnetEpochConfig(): MainnetEpochConfig {
  const startAtIso = parseEpochStartAt(process.env.MAINNET_EPOCH_START_AT);
  const startTick = parseEpochStartTick(process.env.MAINNET_EPOCH_START_TICK);
  const hasBoundary = Boolean(startAtIso) || startTick !== null;
  const rawEnabled = process.env.MAINNET_EPOCH_ENABLED;
  const explicitlyEnabled = rawEnabled === 'true';
  const explicitlyDisabled = rawEnabled === 'false';

  return {
    enabled:
      getXLayerNetwork() === 'mainnet' &&
      !explicitlyDisabled &&
      (explicitlyEnabled || hasBoundary),
    startAtIso,
    startTick,
  };
}

export function getMainnetEpochMeta(): Record<string, unknown> {
  const config = getMainnetEpochConfig();
  return {
    enabled: config.enabled,
    startAt: config.startAtIso,
    startTick: config.startTick,
  };
}

export function pushMainnetEpochStartAtParam(params: EpochParam[]): string | null {
  const { enabled, startAtIso } = getMainnetEpochConfig();
  if (!enabled || !startAtIso) {
    return null;
  }

  params.push(startAtIso);
  return `$${params.length}`;
}

export function pushMainnetEpochStartTickParam(params: EpochParam[]): string | null {
  const { enabled, startTick } = getMainnetEpochConfig();
  if (!enabled || startTick === null) {
    return null;
  }

  params.push(startTick);
  return `$${params.length}`;
}

export function appendMainnetEpochCreatedAtFilter(
  where: string[],
  params: EpochParam[],
  columnRef: string,
): void {
  const placeholder = pushMainnetEpochStartAtParam(params);
  if (placeholder) {
    where.push(`${columnRef} >= ${placeholder}`);
  }
}

export function appendMainnetEpochTickFilter(
  where: string[],
  params: EpochParam[],
  columnRef: string,
): void {
  const placeholder = pushMainnetEpochStartTickParam(params);
  if (placeholder) {
    where.push(`${columnRef} >= ${placeholder}`);
  }
}
