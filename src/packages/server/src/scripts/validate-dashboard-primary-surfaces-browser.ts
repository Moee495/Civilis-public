import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type CaptureMode = 'clean_exit' | 'recovered_from_timeout';

interface RouteCheckResult {
  route: string;
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

interface ValidationReport {
  action: 'validate_dashboard_primary_surfaces_browser';
  dashboardUrl: string;
  expectedApiBase: string;
  chromeBinary: string;
  captureMode: CaptureMode;
  captureWarnings: string[];
  routeResults: RouteCheckResult[];
  failures: Array<{
    route: string;
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

async function dumpDom(chromeBinary: string, url: string): Promise<{
  dom: string;
  captureMode: CaptureMode;
  captureWarnings: string[];
}> {
  const userDataDir = (await execFileAsync('mktemp', ['-d'])).stdout.trim();
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
          url,
        ],
        {
          maxBuffer: 8 * 1024 * 1024,
          timeout: 20_000,
          killSignal: 'SIGKILL',
        },
      );
      return {
        dom: result.stdout.toString(),
        captureMode: 'clean_exit',
        captureWarnings: [],
      };
    } catch (error) {
      const captureError = error as Error & {
        stdout?: Buffer | string;
        signal?: string | null;
      };
      const recoveredStdout = captureError.stdout?.toString() ?? '';
      if (recoveredStdout.includes('<!DOCTYPE html>')) {
        return {
          dom: recoveredStdout,
          captureMode: 'recovered_from_timeout',
          captureWarnings: [`chrome exited via ${captureError.signal ?? 'error'} after DOM capture; using recovered stdout`],
        };
      }
      throw error;
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
}

function pushRouteCheck(
  routeResult: RouteCheckResult,
  route: string,
  name: string,
  passed: boolean,
  details: Record<string, unknown>,
  failure?: { expected: unknown; actual: unknown },
): void {
  routeResult.checks.push({ name, status: passed ? 'pass' : 'fail', details });
  if (!passed && failure) {
    routeResult.failures.push({ check: name, ...failure });
  }
}

async function main(): Promise<void> {
  const dashboardUrl = normalizeUrl(
    readArg('dashboard-url') || process.env.WORLD_EVENT_VALIDATION_DASHBOARD_URL || 'http://127.0.0.1:3000',
  );
  const expectedApiBase = normalizeUrl(
    readArg('expected-api-base') || process.env.WORLD_EVENT_VALIDATION_BASE_URL || 'http://127.0.0.1:3132',
  );
  const chromeBinary =
    readArg('chrome-bin') ||
    process.env.CHROME_BIN ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  const routes = [
    {
      route: '/',
      markers: ['CIVILIS', 'SQUARE SPOTLIGHT', 'SOCIAL SQUARE'],
    },
    {
      route: '/commerce',
      markers: ['PROTOCOL HUB', 'ON-CHAIN COMMERCE &amp; DELIVERY RECORDS'],
    },
    {
      route: '/intel',
      markers: ['INTEL EXCHANGE', 'COUNTER-INTEL &amp; LEDGER'],
    },
    {
      route: '/agents',
      markers: ['AGENTS', 'ERC-8004'],
    },
    {
      route: '/arena',
      markers: ['ARENA'],
    },
    {
      route: '/graveyard',
      markers: ['GRAVEYARD', 'Every soul has a story'],
    },
  ];

  const routeResults: RouteCheckResult[] = [];
  const failures: ValidationReport['failures'] = [];
  let captureMode: CaptureMode = 'clean_exit';
  const captureWarnings: string[] = [];

  for (const routeConfig of routes) {
    const targetUrl = `${dashboardUrl}${routeConfig.route}`;
    const capture = await dumpDom(chromeBinary, targetUrl);
    if (capture.captureMode === 'recovered_from_timeout') {
      captureMode = 'recovered_from_timeout';
      captureWarnings.push(...capture.captureWarnings.map((warning) => `${routeConfig.route}: ${warning}`));
    }
    const dom = capture.dom;
    const routeResult: RouteCheckResult = {
      route: routeConfig.route,
      checks: [],
      failures: [],
    };

    const hasCivilisTitle = dom.includes('CIVILIS — Onchain Civilization Protocol');
    pushRouteCheck(
      routeResult,
      routeConfig.route,
      'civilis_title_present',
      hasCivilisTitle,
      { hasCivilisTitle },
      { expected: true, actual: hasCivilisTitle },
    );

    const hasRuntimeConfig = dom.includes(`"apiBase":"${expectedApiBase}"`);
    pushRouteCheck(
      routeResult,
      routeConfig.route,
      'runtime_config_injected',
      hasRuntimeConfig,
      { expectedApiBase, hasRuntimeConfig },
      { expected: expectedApiBase, actual: hasRuntimeConfig ? expectedApiBase : null },
    );

    const hasTradeDna = dom.includes('TradeDNA');
    pushRouteCheck(
      routeResult,
      routeConfig.route,
      'trade_dna_absent',
      !hasTradeDna,
      { hasTradeDna },
      { expected: false, actual: hasTradeDna },
    );

    const missingMarkers = routeConfig.markers.filter((marker) => !dom.includes(marker));
    pushRouteCheck(
      routeResult,
      routeConfig.route,
      'surface_markers_present',
      missingMarkers.length === 0,
      { markers: routeConfig.markers, missingMarkers },
      { expected: routeConfig.markers, actual: missingMarkers },
    );

    if (routeResult.failures.length > 0) {
      failures.push(
        ...routeResult.failures.map((failure) => ({
          route: routeConfig.route,
          ...failure,
        })),
      );
    }
    routeResults.push(routeResult);
  }

  const report: ValidationReport = {
    action: 'validate_dashboard_primary_surfaces_browser',
    dashboardUrl,
    expectedApiBase,
    chromeBinary,
    captureMode,
    captureWarnings,
    routeResults,
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
