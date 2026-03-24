interface Args {
  baseUrl: string;
  dashboardUrl: string;
  samples: number;
  intervalMs: number;
}

interface HealthSummary {
  statusCode: number;
  network: string | null;
  x402: string | null;
  soul: string | null;
  soulArchiveMode: string | null;
  protocolInit: string | null;
  error?: string;
}

interface AcpSummary {
  statusCode: number;
  localLedgerTotal: number | null;
  localLedgerCompleted: number | null;
  localLedgerActive: number | null;
  onChainJobCount: number | null;
  escrowSurface: string | null;
  mappingMode: string | null;
  x402PaymentMode: string | null;
  pendingReputationFeedback: number | null;
  error?: string;
}

interface WorldSummary {
  statusCode: number;
  latestTickRunStatus: string | null;
  latestTickNumber: number | null;
  modifierStacksCount: number | null;
  marketResolvedSource: string | null;
  marketProvider: string | null;
  marketTransport: string | null;
  error?: string;
}

interface PageSummary {
  root: number;
  world: number;
  commerce: number;
  agentChaos: number;
  intel: number;
}

interface Snapshot {
  takenAt: string;
  health: HealthSummary;
  acp: AcpSummary;
  world: WorldSummary;
  pages: PageSummary;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: 'http://127.0.0.1:3011',
    dashboardUrl: 'http://127.0.0.1:3010',
    samples: 1,
    intervalMs: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--') {
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      args.baseUrl = arg.slice('--base-url='.length);
    } else if (arg === '--base-url' && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg.startsWith('--dashboard-url=')) {
      args.dashboardUrl = arg.slice('--dashboard-url='.length);
    } else if (arg === '--dashboard-url' && next) {
      args.dashboardUrl = next;
      i += 1;
    } else if (arg.startsWith('--samples=')) {
      args.samples = Number(arg.slice('--samples='.length));
    } else if (arg === '--samples' && next) {
      args.samples = Number(next);
      i += 1;
    } else if (arg.startsWith('--interval-ms=')) {
      args.intervalMs = Number(arg.slice('--interval-ms='.length));
    } else if (arg === '--interval-ms' && next) {
      args.intervalMs = Number(next);
      i += 1;
    }
  }

  if (!Number.isFinite(args.samples) || args.samples < 1) {
    throw new Error(`invalid --samples value: ${args.samples}`);
  }
  if (!Number.isFinite(args.intervalMs) || args.intervalMs < 0) {
    throw new Error(`invalid --interval-ms value: ${args.intervalMs}`);
  }

  return args;
}

async function fetchJson(url: string): Promise<{ statusCode: number; data: any; error?: string }> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return { statusCode: response.status, data: null, error: 'invalid_json' };
    }
    return { statusCode: response.status, data };
  } catch (error) {
    return {
      statusCode: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchStatus(url: string): Promise<number> {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    return response.status;
  } catch {
    return 0;
  }
}

async function captureSnapshot(baseUrl: string, dashboardUrl: string): Promise<Snapshot> {
  const [healthRaw, acpRaw, worldRaw, rootStatus, worldStatus, commerceStatus, agentStatus, intelStatus] =
    await Promise.all([
      fetchJson(`${baseUrl}/health`),
      fetchJson(`${baseUrl}/api/acp/stats`),
      fetchJson(`${baseUrl}/api/world/overview?limit=1`),
      fetchStatus(`${dashboardUrl}/`),
      fetchStatus(`${dashboardUrl}/world`),
      fetchStatus(`${dashboardUrl}/commerce`),
      fetchStatus(`${dashboardUrl}/agents/chaos`),
      fetchStatus(`${dashboardUrl}/intel`),
    ]);

  return {
    takenAt: new Date().toISOString(),
    health: {
      statusCode: healthRaw.statusCode,
      network: healthRaw.data?.checks?.network ?? null,
      x402: healthRaw.data?.checks?.x402 ?? null,
      soul: healthRaw.data?.checks?.soul ?? null,
      soulArchiveMode: healthRaw.data?.readiness?.soulArchiveMode ?? null,
      protocolInit: healthRaw.data?.checks?.protocolInit ?? null,
      error: healthRaw.error,
    },
    acp: {
      statusCode: acpRaw.statusCode,
      localLedgerTotal: acpRaw.data?.localLedger?.total ?? null,
      localLedgerCompleted: acpRaw.data?.localLedger?.completedCount ?? null,
      localLedgerActive: acpRaw.data?.localLedger?.activeCount ?? null,
      onChainJobCount: acpRaw.data?.onChainSync?.jobCount ?? null,
      escrowSurface: acpRaw.data?.protocolLayers?.escrow8183?.surface ?? null,
      mappingMode: acpRaw.data?.protocolLayers?.commerceMapping?.mode ?? null,
      x402PaymentMode: acpRaw.data?.protocolLayers?.x402Rail?.paymentMode ?? null,
      pendingReputationFeedback: acpRaw.data?.queues?.pendingReputationFeedback ?? null,
      error: acpRaw.error,
    },
    world: {
      statusCode: worldRaw.statusCode,
      latestTickRunStatus: worldRaw.data?.latestTickRun?.status ?? null,
      latestTickNumber: worldRaw.data?.latestTickRun?.tickNumber ?? null,
      modifierStacksCount: Array.isArray(worldRaw.data?.modifierStacks) ? worldRaw.data.modifierStacks.length : null,
      marketResolvedSource: worldRaw.data?.marketOracleStatus?.lastResolvedSource ?? null,
      marketProvider: worldRaw.data?.marketOracleStatus?.lastProvider ?? null,
      marketTransport: worldRaw.data?.marketOracleStatus?.lastTransport ?? null,
      error: worldRaw.error,
    },
    pages: {
      root: rootStatus,
      world: worldStatus,
      commerce: commerceStatus,
      agentChaos: agentStatus,
      intel: intelStatus,
    },
  };
}

function computeSummary(samples: Snapshot[]) {
  const allPageHealthy = samples.every((sample) =>
    [sample.pages.root, sample.pages.world, sample.pages.commerce, sample.pages.agentChaos, sample.pages.intel]
      .every((statusCode) => statusCode === 200)
  );
  const allApiHealthy = samples.every((sample) =>
    sample.health.statusCode === 200 &&
    sample.acp.statusCode === 200 &&
    sample.world.statusCode === 200
  );

  const first = samples[0];
  const stableCoreSignals = samples.every((sample) =>
    sample.health.network === first.health.network &&
    sample.health.x402 === first.health.x402 &&
    sample.health.soul === first.health.soul &&
    sample.health.soulArchiveMode === first.health.soulArchiveMode &&
    sample.acp.x402PaymentMode === first.acp.x402PaymentMode &&
    sample.world.marketResolvedSource === first.world.marketResolvedSource
  );

  return {
    sampleCount: samples.length,
    allPageHealthy,
    allApiHealthy,
    stableCoreSignals,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const snapshots: Snapshot[] = [];

  for (let i = 0; i < args.samples; i += 1) {
    snapshots.push(await captureSnapshot(args.baseUrl, args.dashboardUrl));
    if (i < args.samples - 1 && args.intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
    }
  }

  console.log(JSON.stringify({
    action: 'capture_mainnet_observation_snapshot',
    target: {
      baseUrl: args.baseUrl,
      dashboardUrl: args.dashboardUrl,
      samples: args.samples,
      intervalMs: args.intervalMs,
    },
    summary: computeSummary(snapshots),
    samples: snapshots,
  }, null, 2));
}

void main();
