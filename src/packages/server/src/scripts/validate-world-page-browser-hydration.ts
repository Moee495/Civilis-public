import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ValidationReport {
  action: 'validate_world_page_browser_hydration';
  dashboardUrl: string;
  expectedApiBase: string;
  chromeBinary: string;
  captureMode: 'clean_exit' | 'recovered_from_timeout';
  captureWarnings: string[];
  checks: Array<{
    name: string;
    status: 'pass' | 'fail';
    details: Record<string, unknown>;
  }>;
  failures: Array<{
    check: string;
    expected: unknown;
    actual: unknown;
  }>;
}

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

async function main(): Promise<void> {
  const dashboardUrl = normalizeUrl(
    readArg('dashboard-url') || process.env.WORLD_EVENT_VALIDATION_DASHBOARD_URL || 'http://127.0.0.1:3026',
  );
  const expectedApiBase = normalizeUrl(
    readArg('expected-api-base') || process.env.WORLD_EVENT_VALIDATION_BASE_URL || 'http://127.0.0.1:3124',
  );
  const chromeBinary =
    readArg('chrome-bin') ||
    process.env.CHROME_BIN ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const userDataDir = (await execFileAsync('mktemp', ['-d'])).stdout.trim();

  let stdout = '';
  let captureMode: ValidationReport['captureMode'] = 'clean_exit';
  const captureWarnings: string[] = [];
  try {
    try {
      const result = await execFileAsync(
        chromeBinary,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${userDataDir}`,
          '--virtual-time-budget=6000',
          '--dump-dom',
          `${dashboardUrl}/world`,
        ],
        {
          maxBuffer: 8 * 1024 * 1024,
          timeout: 20_000,
          killSignal: 'SIGKILL',
        },
      );
      stdout = result.stdout.toString();
    } catch (error) {
      const captureError = error as Error & {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        signal?: string | null;
      };
      const recoveredStdout = captureError.stdout?.toString() ?? '';
      if (recoveredStdout.includes('<!DOCTYPE html>')) {
        stdout = recoveredStdout;
        captureMode = 'recovered_from_timeout';
        captureWarnings.push(
          `chrome exited via ${captureError.signal ?? 'error'} after DOM capture; using recovered stdout`,
        );
      } else {
        throw error;
      }
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
  const dom = stdout.toString();
  const checks: ValidationReport['checks'] = [];
  const failures: ValidationReport['failures'] = [];

  const push = (
    name: string,
    passed: boolean,
    details: Record<string, unknown>,
    failure?: { expected: unknown; actual: unknown },
  ) => {
    checks.push({ name, status: passed ? 'pass' : 'fail', details });
    if (!passed && failure) {
      failures.push({ check: name, ...failure });
    }
  };

  const hasCivilisTitle = dom.includes('CIVILIS — Onchain Civilization Protocol');
  push(
    'civilis_title_present',
    hasCivilisTitle,
    { hasCivilisTitle },
    { expected: true, actual: hasCivilisTitle },
  );

  const hasRuntimeConfig = dom.includes(`"apiBase":"${expectedApiBase}"`);
  push(
    'runtime_config_injected',
    hasRuntimeConfig,
    { expectedApiBase, hasRuntimeConfig },
    { expected: expectedApiBase, actual: hasRuntimeConfig ? expectedApiBase : null },
  );

  const hasTradeDna = dom.includes('TradeDNA');
  push(
    'trade_dna_absent',
    !hasTradeDna,
    { hasTradeDna },
    { expected: false, actual: hasTradeDna },
  );

  const hasHydratedTick = /WORLD TICK[\s\S]*?#<!-- -->\d+|WORLD TICK[\s\S]*?#\d+/.test(dom);
  push(
    'hydrated_world_tick',
    hasHydratedTick,
    { hasHydratedTick },
    { expected: 'hydrated world tick content', actual: hasHydratedTick },
  );

  const hasLatestTickRunLine =
    dom.includes('Latest tick run') &&
    /T\d+/.test(dom) &&
    (dom.includes('Completed') || dom.includes('Started') || dom.includes('Failed'));
  const hasCurrentOracleLine =
    dom.includes('Current oracle: live') ||
    dom.includes('Current oracle: mock') ||
    dom.includes('Current oracle: unresolved');
  const hasPdSemanticsLine = dom.includes('PD net-pool semantics treasury_cut_inverse');
  const hasHydratedAnalytics = hasLatestTickRunLine && hasCurrentOracleLine && hasPdSemanticsLine;
  push(
    'hydrated_world_analytics_surface',
    hasHydratedAnalytics,
    { hasHydratedAnalytics, hasLatestTickRunLine, hasCurrentOracleLine, hasPdSemanticsLine },
    { expected: 'hydrated analytics content present', actual: hasHydratedAnalytics },
  );

  const hasConsumerCoverage =
    dom.includes('agent: active/verified') &&
    dom.includes('social: idle/verified') &&
    dom.includes('fate_intel: idle/missing_natural_sample') &&
    dom.includes('P1 consumer integration 88%');
  push(
    'hydrated_consumer_coverage_surface',
    hasConsumerCoverage,
    { hasConsumerCoverage },
    { expected: 'hydrated consumer coverage content present', actual: hasConsumerCoverage },
  );

  const report: ValidationReport = {
    action: 'validate_world_page_browser_hydration',
    dashboardUrl,
    expectedApiBase,
    chromeBinary,
    captureMode,
    captureWarnings,
    checks,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
