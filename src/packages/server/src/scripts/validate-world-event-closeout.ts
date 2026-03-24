import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(SCRIPT_DIR, '../../../../');

interface ScriptResult {
  name: string;
  status: 'pass' | 'fail';
  parsed: unknown | null;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseJsonFromMixedOutput(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

async function runJsonScript(name: string, args: string[]): Promise<ScriptResult> {
  try {
    const result = await execFileAsync(
      'pnpm',
      ['--filter', '@agentverse/server', 'exec', 'tsx', ...args],
      {
        cwd: SRC_ROOT,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      },
    );

    const stdout = result.stdout.toString().trim();
    const stderr = result.stderr.toString().trim();
    return {
      name,
      status: 'pass',
      parsed: parseJsonFromMixedOutput(stdout),
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (error) {
    const execError = error as Error & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      code?: number;
    };
    const stdout = execError.stdout?.toString().trim() ?? '';
    const stderr = execError.stderr?.toString().trim() ?? execError.message;
    return {
      name,
      status: 'fail',
      parsed: parseJsonFromMixedOutput(stdout),
      stdout,
      stderr,
      exitCode: execError.code ?? 1,
    };
  }
}

async function main(): Promise<void> {
  const baseUrl = normalizeUrl(
    readArg('base-url') || process.env.WORLD_EVENT_VALIDATION_BASE_URL || 'http://127.0.0.1:3138',
  );
  const dashboardUrl = normalizeUrl(
    readArg('dashboard-url') || process.env.WORLD_EVENT_VALIDATION_DASHBOARD_URL || 'http://127.0.0.1:3000',
  );
  const agentId = (readArg('agent-id') || process.env.WORLD_EVENT_VALIDATION_AGENT_ID || 'chaos').trim();

  const results: ScriptResult[] = [];

  // Run validators serially so the closeout path does not overwhelm local
  // browser/runtime resources during release checks.
  results.push(await runJsonScript('consistency', [
      'src/scripts/validate-world-event-consistency.ts',
      `--base-url=${baseUrl}`,
      `--dashboard-url=${dashboardUrl}`,
      `--agent-id=${agentId}`,
    ]));
  results.push(await runJsonScript('world_page_browser', [
      'src/scripts/validate-world-page-browser-hydration.ts',
      `--dashboard-url=${dashboardUrl}`,
      `--expected-api-base=${baseUrl}`,
    ]));
  results.push(await runJsonScript('agent_world_exposure_browser', [
      'src/scripts/validate-agent-world-exposure-browser.ts',
      `--dashboard-url=${dashboardUrl}`,
      `--expected-api-base=${baseUrl}`,
      `--agent-id=${agentId}`,
    ]));
  results.push(await runJsonScript('primary_surfaces_browser', [
      'src/scripts/validate-dashboard-primary-surfaces-browser.ts',
      `--dashboard-url=${dashboardUrl}`,
      `--expected-api-base=${baseUrl}`,
    ]));
  results.push(await runJsonScript('dashboard_route_coverage', [
      'src/scripts/validate-dashboard-route-coverage.ts',
    ]));
  const failures = results.filter((result) => result.status === 'fail');

  console.log(
    JSON.stringify(
      {
        action: 'validate_world_event_closeout',
        baseUrl,
        dashboardUrl,
        agentId,
        status: failures.length === 0 ? 'pass' : 'fail',
        summary: {
          totalChecks: results.length,
          passedChecks: results.filter((result) => result.status === 'pass').length,
          failedChecks: failures.length,
        },
        results: results.map((result) => ({
          name: result.name,
          status: result.status,
          exitCode: result.exitCode,
          parsed: result.parsed,
          stderr: result.stderr || null,
        })),
      },
      null,
      2,
    ),
  );

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
