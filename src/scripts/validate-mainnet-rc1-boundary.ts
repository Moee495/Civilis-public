import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Classification =
  | 'launch_core'
  | 'follow_up'
  | 'public_review'
  | 'local_noise'
  | 'unclassified';

interface StatusEntry {
  status: string;
  path: string;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../..');

const launchCorePaths = new Set([
  '.gitignore',
  'README.md',
  'audit-package/README.md',
  'src/.env.example',
  'src/.env.mainnet.release.example',
  'src/package.json',
  'docs/mainnet-limited-rollout-observation-log.md',
  'docs/mainnet-launch-change-inventory.md',
  'docs/mainnet-launch-execution-plan.md',
  'docs/mainnet-launch-issue-ledger.md',
  'docs/mainnet-go-no-go-checklist.md',
  'docs/mainnet-canary-observation.md',
  'docs/world-event-refactor-status.md',
  'src/scripts/prepare-mainnet-release-env.ts',
  'src/scripts/activate-mainnet-release-env.ts',
  'src/scripts/restore-env-backup.ts',
  'src/scripts/capture-mainnet-observation-snapshot.ts',
  'src/scripts/validate-mainnet-rc1-boundary.ts',
  'src/packages/agent/src/agent-runtime.ts',
  'src/packages/agent/src/decision-engine.ts',
  'src/packages/agent/src/x402-client.ts',
  'src/packages/dashboard/src/app/agents/[id]/page.tsx',
  'src/packages/dashboard/src/app/arena/page.tsx',
  'src/packages/dashboard/src/app/commerce/page.tsx',
  'src/packages/dashboard/src/app/intel/page.tsx',
  'src/packages/dashboard/src/app/layout.tsx',
  'src/packages/dashboard/src/app/page.tsx',
  'src/packages/dashboard/src/app/world/page.tsx',
  'src/packages/dashboard/src/components/ClientFooter.tsx',
  'src/packages/dashboard/src/components/MarketTicker.tsx',
  'src/packages/dashboard/src/lib/api.ts',
  'src/packages/dashboard/src/lib/socket.ts',
  'src/packages/dashboard/src/lib/runtime-config.ts',
  'src/packages/server/src/agents/wallet-sync.ts',
  'src/packages/server/src/arena/payoff-matrix.ts',
  'src/packages/server/src/arena/settlement.ts',
  'src/packages/server/src/commons/commons-settlement.ts',
  'src/packages/server/src/config/load-env.ts',
  'src/packages/server/src/config/soul-archive.ts',
  'src/packages/server/src/config/x402-service.ts',
  'src/packages/server/src/config/xlayer.ts',
  'src/packages/server/src/db/postgres.ts',
  'src/packages/server/src/fate/fate-engine.ts',
  'src/packages/server/src/index.ts',
  'src/packages/server/src/intel/intel-phase-gate.ts',
  'src/packages/server/src/nurture/nurture-updater.ts',
  'src/packages/server/src/onchainos/x402bridge.ts',
  'src/packages/server/src/prediction/prediction-lifecycle.ts',
  'src/packages/server/src/scripts/apply-world-event-schema.ts',
  'src/packages/server/src/scripts/check-mainnet-readiness.ts',
  'src/packages/server/src/scripts/validate-agent-world-exposure-browser.ts',
  'src/packages/server/src/scripts/validate-dashboard-primary-surfaces-browser.ts',
  'src/packages/server/src/scripts/validate-dashboard-route-coverage.ts',
  'src/packages/server/src/scripts/validate-world-event-closeout.ts',
  'src/packages/server/src/scripts/validate-world-event-consistency.ts',
  'src/packages/server/src/scripts/validate-world-modifier-observability.ts',
  'src/packages/server/src/scripts/validate-world-page-browser-hydration.ts',
  'src/packages/server/src/scripts/validate-world-pd-payout-semantics.ts',
  'src/packages/server/src/scripts/validate-x402-service-target.ts',
  'src/packages/server/src/social/social-square.ts',
  'src/packages/server/src/standards/agent-card.ts',
  'src/packages/server/src/world/config.ts',
  'src/packages/server/src/world/event-runs.ts',
  'src/packages/server/src/world/events.ts',
  'src/packages/server/src/world/exposure.ts',
  'src/packages/server/src/world/market-oracle.ts',
  'src/packages/server/src/world/modifiers.ts',
  'src/packages/server/src/world/routes.ts',
  'src/packages/server/src/world/signals.ts',
  'src/packages/server/src/world/tick-engine.ts',
  'src/packages/server/src/world/tick-runs.ts',
]);

const followUpPaths = new Set([
  'src/packages/dashboard/src/lib/dynamic-text.ts',
  'src/packages/dashboard/src/lib/event-format.ts',
]);

const publicReviewPaths = new Set([
  'README.md',
  'audit-package/README.md',
]);

const localNoisePrefixes = [
  'brand/',
];

function readStatus(): StatusEntry[] {
  const output = execFileSync('git', ['status', '--short'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const normalizedPath = rawPath
        .replace(/^"+|"+$/g, '')
        .replace(/\\351\\223\\276/g, '链');

      return {
        status,
        path: normalizedPath,
      };
    });
}

function classify(entry: StatusEntry): Classification {
  if (launchCorePaths.has(entry.path)) {
    return 'launch_core';
  }

  if (followUpPaths.has(entry.path)) {
    return 'follow_up';
  }

  if (publicReviewPaths.has(entry.path)) {
    return 'public_review';
  }

  if (localNoisePrefixes.some((prefix) => entry.path.startsWith(prefix))) {
    return 'local_noise';
  }

  return 'unclassified';
}

function main(): void {
  const entries = readStatus();
  const classified = entries.map((entry) => ({
    ...entry,
    classification: classify(entry),
  }));

  const summary = {
    totalEntries: classified.length,
    launchCore: classified.filter((entry) => entry.classification === 'launch_core').length,
    followUp: classified.filter((entry) => entry.classification === 'follow_up').length,
    publicReview: classified.filter((entry) => entry.classification === 'public_review').length,
    localNoise: classified.filter((entry) => entry.classification === 'local_noise').length,
    unclassified: classified.filter((entry) => entry.classification === 'unclassified').length,
  };

  const unclassified = classified.filter((entry) => entry.classification === 'unclassified');

  console.log(JSON.stringify({
    action: 'validate_mainnet_rc1_boundary',
    root: ROOT,
    summary,
    entries: classified,
    unclassified,
  }, null, 2));

  if (unclassified.length > 0) {
    process.exit(1);
  }
}

main();
