import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type CaptureMode = 'clean_exit' | 'recovered_from_timeout';

interface RouteCheck {
  name: string;
  status: 'pass' | 'fail';
  details: Record<string, unknown>;
}

interface RouteReport {
  route: string;
  checks: RouteCheck[];
  failures: Array<{
    check: string;
    expected: unknown;
    actual: unknown;
  }>;
}

interface ValidationReport {
  action: 'validate_launch_final_frontend';
  dashboardUrl: string;
  expectedApiBase: string;
  chromeBinary: string;
  captureMode: CaptureMode;
  captureWarnings: string[];
  routes: RouteReport[];
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
          '--virtual-time-budget=12000',
          '--dump-dom',
          url,
        ],
        {
          maxBuffer: 16 * 1024 * 1024,
          timeout: 25_000,
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

function pushCheck(
  routeReport: RouteReport,
  name: string,
  passed: boolean,
  details: Record<string, unknown>,
  failure?: { expected: unknown; actual: unknown },
): void {
  routeReport.checks.push({ name, status: passed ? 'pass' : 'fail', details });
  if (!passed && failure) {
    routeReport.failures.push({ check: name, ...failure });
  }
}

function includesAny(dom: string, candidates: string[]): boolean {
  return candidates.some((candidate) => dom.includes(candidate));
}

async function main(): Promise<void> {
  const dashboardUrl = normalizeUrl(
    readArg('dashboard-url') || process.env.WORLD_EVENT_VALIDATION_DASHBOARD_URL || 'http://127.0.0.1:3010',
  );
  const expectedApiBase = normalizeUrl(
    readArg('expected-api-base') || process.env.WORLD_EVENT_VALIDATION_BASE_URL || 'http://127.0.0.1:3011',
  );
  const chromeBinary =
    readArg('chrome-bin') ||
    process.env.CHROME_BIN ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  const routeConfigs = [
    {
      route: '/',
      presenceChecks: [
        {
          name: 'home_social_square_copy_present',
          markers: [
            '八个智能体在这里发言、互相打赏、设置付费墙、留下遗言，再把这些关系带进竞技场、情报市场与链上身份系统。',
            'Eight agents speak, tip one another, set paywalls, and leave farewells here before carrying those relationships into the arena, intel market, and on-chain identity system.',
          ],
        },
      ],
      absenceChecks: [
        {
          name: 'home_old_square_copy_absent',
          markers: ['这里首先是广场，而不是行情页。'],
        },
        {
          name: 'home_internal_badges_absent',
          markers: ['ERC-8183', 'TEE', 'Zero Gas · OKB'],
        },
      ],
    },
    {
      route: '/world',
      presenceChecks: [
        {
          name: 'world_recent_tick_surface_present',
          markers: ['最近轮次', 'LATEST TICK'],
        },
        {
          name: 'world_market_source_surface_present',
          markers: ['当前行情源：', 'Current market source:'],
        },
        {
          name: 'world_summary_surface_present',
          markers: ['世界摘要', 'WORLD SUMMARY'],
        },
      ],
      absenceChecks: [
        {
          name: 'world_old_dense_hero_absent',
          markers: ['Civilis 文明实时监控台', '当前 oracle：', 'Current oracle:'],
        },
      ],
    },
    {
      route: '/commerce',
      presenceChecks: [
        {
          name: 'commerce_core_surface_present',
          markers: ['商业与支付网络', 'COMMERCE & PAYMENTS', '支付网络', 'PAYMENT NETWORK'],
        },
      ],
      absenceChecks: [
        {
          name: 'commerce_old_top_panel_absent',
          markers: ['链上商业与交付记录网络', 'ON-CHAIN COMMERCE &amp; DELIVERY RECORDS'],
        },
        {
          name: 'commerce_internal_rollout_copy_absent',
          markers: ['canary', 'testnet', 'PROTOCOL HUB', '协议中枢', 'PROTOCOL SPECIFICATION'],
        },
      ],
    },
    {
      route: '/intel',
      presenceChecks: [
        {
          name: 'intel_core_surface_present',
          markers: ['INTEL EXCHANGE', '战略情报交易所', '命格挂单'],
        },
      ],
      absenceChecks: [
        {
          name: 'intel_old_top_guidance_absent',
          markers: ['当前协议口径', '如何阅读这个市场'],
        },
        {
          name: 'intel_internal_rule_copy_absent',
          markers: ['Revenue & Protocol Path', 'Protocol Path & Constraints', '收益与协议路径', '协议路径与限制'],
        },
      ],
    },
    {
      route: '/agents/chaos',
      presenceChecks: [
        {
          name: 'agent_financial_labels_present',
          markers: ['Civilis 余额', 'Civilis Balance'],
        },
        {
          name: 'agent_payment_label_present',
          markers: ['支付余额', 'Payment Balance'],
        },
        {
          name: 'agent_arena_label_present',
          markers: ['竞技战绩', 'Arena Record'],
        },
      ],
      absenceChecks: [
        {
          name: 'agent_old_balance_label_absent',
          markers: ['Civilis活动账本余额', 'Civilis 账本余额', 'x402 预付余额', '竞技胜负'],
        },
      ],
    },
    {
      route: '/graveyard',
      presenceChecks: [
        {
          name: 'graveyard_rules_button_present',
          markers: ['查看死亡规则', 'Death Rules'],
        },
      ],
      absenceChecks: [],
    },
  ];

  const routes: RouteReport[] = [];
  const failures: ValidationReport['failures'] = [];
  let captureMode: CaptureMode = 'clean_exit';
  const captureWarnings: string[] = [];

  for (const routeConfig of routeConfigs) {
    const capture = await dumpDom(chromeBinary, `${dashboardUrl}${routeConfig.route}`);
    if (capture.captureMode === 'recovered_from_timeout') {
      captureMode = 'recovered_from_timeout';
      captureWarnings.push(...capture.captureWarnings.map((warning) => `${routeConfig.route}: ${warning}`));
    }

    const dom = capture.dom;
    const routeReport: RouteReport = {
      route: routeConfig.route,
      checks: [],
      failures: [],
    };

    const hasCivilisTitle = dom.includes('<title>CIVILIS</title>');
    pushCheck(
      routeReport,
      'civilis_title_present',
      hasCivilisTitle,
      { hasCivilisTitle },
      { expected: true, actual: hasCivilisTitle },
    );

    const hasRuntimeConfig = dom.includes(`"apiBase":"${expectedApiBase}"`);
    pushCheck(
      routeReport,
      'runtime_config_injected',
      hasRuntimeConfig,
      { expectedApiBase, hasRuntimeConfig },
      { expected: expectedApiBase, actual: hasRuntimeConfig ? expectedApiBase : null },
    );

    const hasTradeDna = dom.includes('TradeDNA');
    pushCheck(
      routeReport,
      'trade_dna_absent',
      !hasTradeDna,
      { hasTradeDna },
      { expected: false, actual: hasTradeDna },
    );

    for (const presenceCheck of routeConfig.presenceChecks) {
      const passed = includesAny(dom, presenceCheck.markers);
      pushCheck(
        routeReport,
        presenceCheck.name,
        passed,
        { markers: presenceCheck.markers },
        { expected: presenceCheck.markers, actual: passed ? 'matched' : 'missing' },
      );
    }

    for (const absenceCheck of routeConfig.absenceChecks) {
      const matchedMarkers = absenceCheck.markers.filter((marker) => dom.includes(marker));
      pushCheck(
        routeReport,
        absenceCheck.name,
        matchedMarkers.length === 0,
        { markers: absenceCheck.markers, matchedMarkers },
        { expected: [], actual: matchedMarkers },
      );
    }

    if (routeReport.failures.length > 0) {
      failures.push(
        ...routeReport.failures.map((failure) => ({
          route: routeConfig.route,
          ...failure,
        })),
      );
    }
    routes.push(routeReport);
  }

  const report: ValidationReport = {
    action: 'validate_launch_final_frontend',
    dashboardUrl,
    expectedApiBase,
    chromeBinary,
    captureMode,
    captureWarnings,
    routes,
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
