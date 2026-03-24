import { getPool } from '../db/postgres.js';
import * as crypto from 'crypto';

export const SUPPORTED_PAIRS = ['OKB-USDT', 'BTC-USDT', 'ETH-USDT'] as const;
export type TradingPair = typeof SUPPORTED_PAIRS[number];

export const PAIR_PROFILES: Record<TradingPair, {
  volatility: 'low' | 'medium' | 'high';
  ecosystem: string;
  preferredBy: string[];
}> = {
  'OKB-USDT': { volatility: 'medium', ecosystem: 'X Layer', preferredBy: ['oracle', 'fox'] },
  'BTC-USDT': { volatility: 'low', ecosystem: 'Bitcoin', preferredBy: ['whale', 'sage', 'monk'] },
  'ETH-USDT': { volatility: 'medium', ecosystem: 'Ethereum', preferredBy: ['echo', 'chaos'] },
};

// Last known prices for mock fallback
const lastKnownPrices: Record<TradingPair, number> = {
  'OKB-USDT': 20.0,
  'BTC-USDT': 85000.0,
  'ETH-USDT': 2100.0,
};

// Try OnchainOS authenticated API first (if configured)
async function fetchFromOnchainOS(instId: string): Promise<number | null> {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  const projectId = process.env.OKX_PROJECT_ID;
  if (!apiKey || !secret || !passphrase || !projectId) return null;

  try {
    const path = `/api/v5/market/ticker?instId=${instId}`;
    const timestamp = new Date().toISOString();
    const sign = crypto.createHmac('sha256', secret).update(timestamp + 'GET' + path).digest('base64');

    const resp = await fetch(`https://web3.okx.com${path}`, {
      headers: {
        'OK-ACCESS-KEY': apiKey,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': passphrase,
        'OK-ACCESS-PROJECT': projectId,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as { data?: Array<{ last: string }> };
    const price = parseFloat(json.data?.[0]?.last ?? '');
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

async function fetchFromOKX(instId: string): Promise<number | null> {
  try {
    const resp = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as { data?: Array<{ last: string }> };
    const price = parseFloat(json.data?.[0]?.last ?? '');
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

async function fetchFromBinance(instId: string): Promise<number | null> {
  try {
    const symbol = instId.replace('-', '');
    const resp = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as { price: string };
    const price = parseFloat(json.price ?? '');
    return isNaN(price) ? null : price;
  } catch {
    return null;
  }
}

export async function fetchCurrentPrice(instId: TradingPair): Promise<number> {
  // Try OnchainOS authenticated API first (higher rate limits, priority access)
  let price = await fetchFromOnchainOS(instId);
  if (price !== null && price > 0) {
    lastKnownPrices[instId] = price;
    return price;
  }

  // Fallback to OKX public API
  price = await fetchFromOKX(instId);
  if (price !== null && price > 0) {
    lastKnownPrices[instId] = price;
    return price;
  }

  // Fallback to Binance
  price = await fetchFromBinance(instId);
  if (price !== null && price > 0) {
    lastKnownPrices[instId] = price;
    return price;
  }

  // Mock mode: generate from last known price
  console.warn(`[PriceFeed] All providers failed for ${instId}, using mock`);
  return generateMockPrice(instId);
}

export function generateMockPrice(instId: TradingPair): number {
  const last = lastKnownPrices[instId];
  const vol = PAIR_PROFILES[instId].volatility;
  const maxChange = vol === 'high' ? 0.02 : vol === 'medium' ? 0.008 : 0.004;
  const change = (Math.random() - 0.5) * 2 * maxChange;
  const newPrice = last * (1 + change);
  lastKnownPrices[instId] = newPrice;
  return newPrice;
}

/**
 * Snapshot all pair prices to DB. Called by tick-engine every tick.
 */
export async function snapshotPrices(tickNumber: number): Promise<Record<TradingPair, number>> {
  const pool = getPool();
  const prices: Record<string, number> = {};

  for (const pair of SUPPORTED_PAIRS) {
    const price = await fetchCurrentPrice(pair);
    prices[pair] = price;
    await pool.query(
      'INSERT INTO price_snapshots (inst_id, price, tick_number) VALUES ($1, $2, $3)',
      [pair, price.toFixed(8), tickNumber],
    );
  }

  return prices as Record<TradingPair, number>;
}

/**
 * Get price at or before a specific tick
 */
export async function getPriceAtTick(instId: TradingPair, tickNumber: number): Promise<number | null> {
  const pool = getPool();
  const result = await pool.query<{ price: string }>(
    'SELECT price FROM price_snapshots WHERE inst_id = $1 AND tick_number <= $2 ORDER BY tick_number DESC LIMIT 1',
    [instId, tickNumber],
  );
  return result.rows[0] ? parseFloat(result.rows[0].price) : null;
}

/**
 * Get recent price changes (percentage) for a pair over last N ticks
 */
export async function getRecentPriceChanges(instId: TradingPair, lastN: number = 10): Promise<number[]> {
  const pool = getPool();
  const result = await pool.query<{ price: string }>(
    'SELECT price FROM price_snapshots WHERE inst_id = $1 ORDER BY tick_number DESC LIMIT $2',
    [instId, lastN + 1],
  );
  const prices = result.rows.map(r => parseFloat(r.price));
  if (prices.length < 2) return [];

  const changes: number[] = [];
  for (let i = 0; i < prices.length - 1; i++) {
    const pctChange = ((prices[i] - prices[i + 1]) / prices[i + 1]) * 100;
    changes.push(pctChange);
  }
  return changes;
}
