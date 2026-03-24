import { getPool } from '../db/postgres.js';
import { marketClient } from '../onchainos/market.js';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export interface MarketCondition {
  btcChange: number;
  ethChange: number;
  okbChange: number;
  btcPrice: number;
  ethPrice: number;
  okbPrice: number;
  source?: 'live' | 'mock';
  provider?: 'okx_node' | 'okx_python' | 'mock';
  transport?: 'node_fetch' | 'python_urllib' | 'mock';
  profile?: string | null;
  resolvedMode?: MarketSignalMode;
  fetchedAt?: string;
  fallbackReason?: string | null;
}

export interface MarketDrivenEvent {
  type: string;
  title: string;
  description: string;
  impact: Record<string, unknown>;
  isMinor?: boolean;
}

type MarketSignalMode = 'live' | 'mock' | 'prefer_mock';

export interface MarketOracleStatus {
  requestedMode: MarketSignalMode;
  lastResolvedSource: 'live' | 'mock' | 'none';
  lastProvider: 'okx_node' | 'okx_python' | 'mock' | 'none';
  lastTransport: 'node_fetch' | 'python_urllib' | 'mock' | 'none';
  liveTransportStrategy: 'auto_live_with_python_fallback' | 'mock_only' | 'prefer_mock';
  nodeTransportStatus: 'healthy' | 'fallback_active' | 'failed' | 'not_attempted';
  lastProfile: string | null;
  lastAttemptedAt: string | null;
  lastSucceededAt: string | null;
  lastFailureAt: string | null;
  lastFallbackReason: string | null;
  lastError: string | null;
}

const marketOracleStatus: MarketOracleStatus = {
  requestedMode: 'live',
  lastResolvedSource: 'none',
  lastProvider: 'none',
  lastTransport: 'none',
  liveTransportStrategy: 'auto_live_with_python_fallback',
  nodeTransportStatus: 'not_attempted',
  lastProfile: null,
  lastAttemptedAt: null,
  lastSucceededAt: null,
  lastFailureAt: null,
  lastFallbackReason: null,
  lastError: null,
};

function getMarketSignalMode(): MarketSignalMode {
  const raw = (process.env.WORLD_EVENT_MARKET_MODE ?? 'live').toLowerCase();
  if (raw === 'mock' || raw === 'prefer_mock') {
    return raw;
  }
  return 'live';
}

function getMockMarketProfile(): string {
  return (process.env.WORLD_EVENT_MARKET_PROFILE ?? 'flat').toLowerCase();
}

function buildMockMarketCondition(profile: string): MarketCondition {
  const base: MarketCondition = (() => {
    switch (profile) {
    case 'panic':
      return {
        btcChange: -4.2,
        ethChange: -1.8,
        okbChange: -2.4,
        btcPrice: 81_400,
        ethPrice: 4_080,
        okbPrice: 61.2,
        source: 'mock',
        provider: 'mock',
        transport: 'mock',
        profile,
      } satisfies MarketCondition;
    case 'boom':
      return {
        btcChange: 1.2,
        ethChange: 2.6,
        okbChange: 6.4,
        btcPrice: 88_600,
        ethPrice: 4_620,
        okbPrice: 74.5,
        source: 'mock',
        provider: 'mock',
        transport: 'mock',
        profile,
      } satisfies MarketCondition;
    case 'fog':
      return {
        btcChange: 0.9,
        ethChange: 5.6,
        okbChange: 1.1,
        btcPrice: 86_900,
        ethPrice: 4_990,
        okbPrice: 68.3,
        source: 'mock',
        provider: 'mock',
        transport: 'mock',
        profile,
      } satisfies MarketCondition;
    case 'flat':
    default:
      return {
        btcChange: 0.4,
        ethChange: 0.6,
        okbChange: 0.5,
        btcPrice: 85_000,
        ethPrice: 4_350,
        okbPrice: 66.5,
        source: 'mock',
        provider: 'mock',
        transport: 'mock',
        profile,
      } satisfies MarketCondition;
    }
  })();

  return {
    ...base,
    resolvedMode: 'mock',
    fetchedAt: new Date().toISOString(),
    fallbackReason: null,
  };
}

async function fetchLiveMarketCondition(): Promise<MarketCondition | null> {
  const [btc, eth, okb] = await Promise.all([
    marketClient.getTicker('BTC-USDT'),
    marketClient.getTicker('ETH-USDT'),
    marketClient.getTicker('OKB-USDT'),
  ]);

  if (!btc || !eth || !okb) {
    return null;
  }

  return {
    btcChange: ((btc.last - btc.open24h) / btc.open24h) * 100,
    ethChange: ((eth.last - eth.open24h) / eth.open24h) * 100,
    okbChange: ((okb.last - okb.open24h) / okb.open24h) * 100,
    btcPrice: btc.last,
    ethPrice: eth.last,
    okbPrice: okb.last,
    source: 'live',
    provider: 'okx_node',
    transport: 'node_fetch',
    profile: null,
    resolvedMode: 'live',
    fetchedAt: new Date().toISOString(),
    fallbackReason: null,
  };
}

async function fetchPythonOkxMarketCondition(): Promise<MarketCondition | null> {
  const script = `
import json
import urllib.request

urls = {
  "btc": "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
  "eth": "https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT",
  "okb": "https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT",
}

headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
result = {}

for key, url in urls.items():
  req = urllib.request.Request(url, headers=headers)
  with urllib.request.urlopen(req, timeout=10) as response:
    payload = json.loads(response.read().decode())
  if payload.get("code") != "0" or not payload.get("data"):
    raise RuntimeError(f"invalid_okx_payload:{key}")
  row = payload["data"][0]
  result[key] = {
    "last": float(row["last"]),
    "open24h": float(row["open24h"]),
  }

print(json.dumps(result))
`.trim();

  const { stdout } = await execFile('python3', ['-c', script], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });

  const payload = JSON.parse(stdout.trim()) as {
    btc?: { last: number; open24h: number };
    eth?: { last: number; open24h: number };
    okb?: { last: number; open24h: number };
  };

  if (!payload.btc || !payload.eth || !payload.okb) {
    return null;
  }

  return {
    btcChange: ((payload.btc.last - payload.btc.open24h) / payload.btc.open24h) * 100,
    ethChange: ((payload.eth.last - payload.eth.open24h) / payload.eth.open24h) * 100,
    okbChange: ((payload.okb.last - payload.okb.open24h) / payload.okb.open24h) * 100,
    btcPrice: payload.btc.last,
    ethPrice: payload.eth.last,
    okbPrice: payload.okb.last,
    source: 'live',
    provider: 'okx_python',
    transport: 'python_urllib',
    profile: null,
    resolvedMode: 'live',
    fetchedAt: new Date().toISOString(),
    fallbackReason: 'node_live_fetch_failed_python_okx_fallback',
  };
}

function updateMarketOracleStatus(partial: Partial<MarketOracleStatus>): void {
  Object.assign(marketOracleStatus, partial);
}

export function getMarketOracleStatus(): MarketOracleStatus {
  return { ...marketOracleStatus };
}

export async function getMarketCondition(): Promise<MarketCondition | null> {
  const mode = getMarketSignalMode();
  const mock = buildMockMarketCondition(getMockMarketProfile());
  const attemptedAt = new Date().toISOString();

  updateMarketOracleStatus({
    requestedMode: mode,
    lastAttemptedAt: attemptedAt,
    liveTransportStrategy:
      mode === 'mock' ? 'mock_only' : mode === 'prefer_mock' ? 'prefer_mock' : 'auto_live_with_python_fallback',
  });

  if (mode === 'mock') {
    updateMarketOracleStatus({
      lastResolvedSource: 'mock',
      lastProvider: 'mock',
      lastTransport: 'mock',
      nodeTransportStatus: 'not_attempted',
      lastProfile: mock.profile ?? null,
      lastSucceededAt: attemptedAt,
      lastFallbackReason: null,
      lastError: null,
    });
    return mock;
  }

  const live = await fetchLiveMarketCondition().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[WorldMarket] live market fetch failed:', error);
    updateMarketOracleStatus({
      lastFailureAt: new Date().toISOString(),
      lastError: message,
    });
    return null;
  });

  if (live) {
    updateMarketOracleStatus({
      lastResolvedSource: 'live',
      lastProvider: live.provider ?? 'okx_node',
      lastTransport: live.transport ?? 'node_fetch',
      nodeTransportStatus: 'healthy',
      lastProfile: null,
      lastSucceededAt: live.fetchedAt ?? attemptedAt,
      lastFallbackReason: null,
      lastError: null,
    });
    return live;
  }

  const pythonLive = await fetchPythonOkxMarketCondition().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[WorldMarket] python OKX live fetch failed:', error);
    updateMarketOracleStatus({
      lastFailureAt: new Date().toISOString(),
      lastError: message,
    });
    return null;
  });

  if (pythonLive) {
    updateMarketOracleStatus({
      lastResolvedSource: 'live',
      lastProvider: pythonLive.provider ?? 'okx_python',
      lastTransport: pythonLive.transport ?? 'python_urllib',
      nodeTransportStatus: 'fallback_active',
      lastProfile: null,
      lastSucceededAt: pythonLive.fetchedAt ?? new Date().toISOString(),
      lastFallbackReason: pythonLive.fallbackReason ?? 'node_live_fetch_failed_python_okx_fallback',
      lastError: null,
    });
    return pythonLive;
  }

  if (mode === 'prefer_mock') {
    const fallbackReason = 'live_fetch_failed_prefer_mock';
    updateMarketOracleStatus({
      lastResolvedSource: 'mock',
      lastProvider: 'mock',
      lastTransport: 'mock',
      nodeTransportStatus: 'failed',
      lastProfile: mock.profile ?? null,
      lastSucceededAt: new Date().toISOString(),
      lastFailureAt: marketOracleStatus.lastFailureAt ?? new Date().toISOString(),
      lastFallbackReason: fallbackReason,
      lastError: marketOracleStatus.lastError ?? 'live_market_unavailable',
    });
    return {
      ...mock,
      resolvedMode: mode,
      fallbackReason,
      fetchedAt: new Date().toISOString(),
    };
  }

  updateMarketOracleStatus({
    lastResolvedSource: 'none',
    lastProvider: 'none',
    lastTransport: 'none',
    nodeTransportStatus: 'failed',
    lastProfile: null,
    lastFailureAt: new Date().toISOString(),
    lastFallbackReason: 'live_fetch_failed_no_mock_fallback',
    lastError: marketOracleStatus.lastError ?? 'live_market_unavailable',
  });
  return null;
}

export async function checkMarketDrivenEvents(
  tick: number,
): Promise<MarketDrivenEvent | null> {
  const market = await getMarketCondition();
  if (!market) {
    return null;
  }

  const pool = getPool();

  if (market.btcChange < -3) {
    await pool.query(
      'UPDATE agents SET risk_tolerance = LEAST(0.95, risk_tolerance + 0.1) WHERE is_alive = true',
    );
    return {
      type: 'market_panic_real',
      title: `市场恐慌: BTC 24h ${market.btcChange.toFixed(1)}%`,
      description: `BTC 跌至 $${market.btcPrice.toFixed(0)}，Civilis 全体风险偏好上调。`,
      impact: {
        riskModifier: 0.1,
        btcPrice: market.btcPrice,
      },
    };
  }

  if (market.okbChange > 5) {
    const airdropAmount = 0.5;
    await pool.query(
      'UPDATE agents SET balance = balance + $1 WHERE is_alive = true',
      [airdropAmount.toFixed(6)],
    );
    return {
      type: 'xlayer_boom_real',
      title: `X Layer 利好: OKB +${market.okbChange.toFixed(1)}%`,
      description: `OKB 涨至 $${market.okbPrice.toFixed(2)}，全体 Agent 获得 ${airdropAmount} USDT 空投。`,
      impact: {
        airdropAmount,
        okbPrice: market.okbPrice,
      },
    };
  }

  if (Math.abs(market.ethChange) > 5) {
    return {
      type: 'mist_deepens_real',
      title: `迷雾加深: ETH ${market.ethChange >= 0 ? '+' : ''}${market.ethChange.toFixed(1)}%`,
      description: `ETH 波动至 $${market.ethPrice.toFixed(0)}，命格揭示成本翻倍。`,
      impact: {
        divinationPriceMultiplier: 2,
        ethPrice: market.ethPrice,
      },
    };
  }

  if (tick % 10 === 0) {
    return {
      type: 'market_update',
      title: '行情播报',
      description: `BTC $${market.btcPrice.toFixed(0)} (${market.btcChange.toFixed(1)}%), OKB $${market.okbPrice.toFixed(2)} (${market.okbChange.toFixed(1)}%)`,
      impact: {
        prices: market,
      },
      isMinor: true,
    };
  }

  return null;
}
