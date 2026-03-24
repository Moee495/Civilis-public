import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ValidationReport {
  action: 'validate_agent_world_exposure_browser';
  dashboardUrl: string;
  expectedApiBase: string;
  agentId: string;
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
    readArg('dashboard-url') || process.env.WORLD_EVENT_VALIDATION_DASHBOARD_URL || 'http://127.0.0.1:3027',
  );
  const expectedApiBase = normalizeUrl(
    readArg('expected-api-base') || process.env.WORLD_EVENT_VALIDATION_BASE_URL || 'http://127.0.0.1:3125',
  );
  const agentId = (readArg('agent-id') || process.env.WORLD_EVENT_VALIDATION_AGENT_ID || 'chaos').trim();
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
          `${dashboardUrl}/agents/${agentId}`,
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

  const hasExposurePanel = dom.includes('WORLD EXPOSURE') || dom.includes('世界影响解释');
  push(
    'agent_world_exposure_panel_present',
    hasExposurePanel,
    { hasExposurePanel },
    { expected: true, actual: hasExposurePanel },
  );

  const hasExposureSummary = dom.includes('Top active domains') || dom.includes('当前最强的影响域');
  push(
    'agent_exposure_summary_present',
    hasExposureSummary,
    { hasExposureSummary },
    { expected: true, actual: hasExposureSummary },
  );

  const hasCurrentWorldPressures =
    dom.includes('CURRENT WORLD PRESSURES') || dom.includes('当前世界压力');
  push(
    'agent_current_world_pressures_present',
    hasCurrentWorldPressures,
    { hasCurrentWorldPressures },
    { expected: true, actual: hasCurrentWorldPressures },
  );

  const hasActiveModifiers = dom.includes('ACTIVE WORLD MODIFIERS') || dom.includes('活跃中的世界修正器');
  push(
    'agent_active_modifiers_present',
    hasActiveModifiers,
    { hasActiveModifiers },
    { expected: true, actual: hasActiveModifiers },
  );

  const hasRecentEvents = dom.includes('RECENT RELEVANT EVENTS') || dom.includes('最近相关世界事件');
  push(
    'agent_recent_world_events_present',
    hasRecentEvents,
    { hasRecentEvents },
    { expected: true, actual: hasRecentEvents },
  );

  const report: ValidationReport = {
    action: 'validate_agent_world_exposure_browser',
    dashboardUrl,
    expectedApiBase,
    agentId,
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
