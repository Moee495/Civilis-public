import * as crypto from 'crypto';

// ─── OnchainOS Auth ──────────────────────────────────────

function getOkxAuthHeaders(method: string, path: string, body: string = ''): Record<string, string> | null {
  const apiKey = process.env.OKX_API_KEY;
  const secret = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  const projectId = process.env.OKX_PROJECT_ID;
  if (!apiKey || !secret || !passphrase || !projectId) return null;

  const timestamp = new Date().toISOString();
  const sign = crypto.createHmac('sha256', secret).update(timestamp + method + path + body).digest('base64');
  return {
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'OK-ACCESS-PROJECT': projectId,
  };
}

const useOnchainOS = (): boolean => !!process.env.OKX_API_KEY && !!process.env.OKX_SECRET_KEY;

// ─── Types ───────────────────────────────────────────────

export interface Ticker {
  instId: string;
  last: number;
  open24h: number;
  high24h: number;
  low24h: number;
  volCcy24h: number;
  vol24h: number;
  timestamp: number;
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class MarketClient {
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 10000; // 10 seconds

  async getTicker(instId: string): Promise<Ticker | null> {
    const cacheKey = `ticker:${instId}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    // Try OnchainOS authenticated API first, then public API
    const endpoints = useOnchainOS()
      ? [
          { url: `https://web3.okx.com/api/v5/market/ticker?instId=${instId}`, auth: true },
          { url: `https://www.okx.com/api/v5/market/ticker?instId=${instId}`, auth: false },
        ]
      : [{ url: `https://www.okx.com/api/v5/market/ticker?instId=${instId}`, auth: false }];

    for (const ep of endpoints) {
      try {
        const headers: Record<string, string> = {};
        if (ep.auth) {
          const authHeaders = getOkxAuthHeaders('GET', `/api/v5/market/ticker?instId=${instId}`);
          if (authHeaders) Object.assign(headers, authHeaders);
        }

        const response = await fetch(ep.url, { headers, signal: AbortSignal.timeout(5000) });
        const data = await response.json() as {
          code?: string;
          data?: Array<Record<string, string>>;
        };

        if (data.code === '0' && data.data && data.data.length > 0) {
          const row = data.data[0];
          const ticker: Ticker = {
            instId: row.instId,
            last: parseFloat(row.last),
            open24h: parseFloat(row.open24h),
            high24h: parseFloat(row.high24h),
            low24h: parseFloat(row.low24h),
            volCcy24h: parseFloat(row.volCcy24h),
            vol24h: parseFloat(row.vol24h),
            timestamp: Date.now(),
          };

          this.cache.set(cacheKey, { data: ticker, timestamp: Date.now() });
          return ticker;
        }
      } catch (error) {
        if (ep.auth) continue; // Try public fallback
        console.error(`Error fetching ticker for ${instId}:`, error);
      }
    }

    return null;
  }

  async getTickers(instIds: string[]): Promise<Ticker[]> {
    const results: Ticker[] = [];

    for (const instId of instIds) {
      const ticker = await this.getTicker(instId);
      if (ticker) {
        results.push(ticker);
      }
    }

    return results;
  }

  async getCandles(instId: string, bar: string = '1H', limit: number = 100): Promise<Candle[]> {
    const cacheKey = `candles:${instId}:${bar}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const queryPath = `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
    const endpoints = useOnchainOS()
      ? [
          { url: `https://web3.okx.com${queryPath}`, auth: true },
          { url: `https://www.okx.com${queryPath}`, auth: false },
        ]
      : [{ url: `https://www.okx.com${queryPath}`, auth: false }];

    for (const ep of endpoints) {
      try {
        const headers: Record<string, string> = {};
        if (ep.auth) {
          const authHeaders = getOkxAuthHeaders('GET', queryPath);
          if (authHeaders) Object.assign(headers, authHeaders);
        }

        const response = await fetch(ep.url, { headers, signal: AbortSignal.timeout(5000) });
        const data = await response.json() as {
          code?: string;
          data?: string[][];
        };

        if (data.code === '0' && data.data && Array.isArray(data.data)) {
          const candles: Candle[] = data.data.map((row: string[]) => ({
            timestamp: parseInt(row[0]),
            open: parseFloat(row[1]),
            high: parseFloat(row[2]),
            low: parseFloat(row[3]),
            close: parseFloat(row[4]),
            volume: parseFloat(row[5]),
          }));

          this.cache.set(cacheKey, { data: candles, timestamp: Date.now() });
          return candles;
        }
      } catch (error) {
        if (ep.auth) continue;
        console.error(`Error fetching candles for ${instId}:`, error);
      }
    }

    return [];
  }

  async getPriceChange(instId: string, minutes: number): Promise<number | null> {
    try {
      const ticker = await this.getTicker(instId);
      if (!ticker) return null;

      const bar = minutes <= 60 ? '1m' : minutes <= 1440 ? '1H' : '1D';
      const candles = await this.getCandles(instId, bar, 100);

      if (candles.length < 2) return null;

      const targetTime = Date.now() - minutes * 60 * 1000;
      let startPrice = candles[candles.length - 1].close;

      for (let i = candles.length - 1; i >= 0; i--) {
        if (candles[i].timestamp <= targetTime) {
          startPrice = candles[i].close;
          break;
        }
      }

      const currentPrice = ticker.last;
      return ((currentPrice - startPrice) / startPrice) * 100;
    } catch (error) {
      console.error(`Error calculating price change for ${instId}:`, error);
    }

    return null;
  }

  async getHistoricalPrice(instId: string, timestamp: number): Promise<number | null> {
    try {
      const candles = await this.getCandles(instId, '1H', 1000);

      if (candles.length === 0) return null;

      // Find candle closest to timestamp
      let closest = candles[0];
      let minDiff = Math.abs(candles[0].timestamp - timestamp);

      for (const candle of candles) {
        const diff = Math.abs(candle.timestamp - timestamp);
        if (diff < minDiff) {
          minDiff = diff;
          closest = candle;
        }
      }

      return closest.close;
    } catch (error) {
      console.error(`Error fetching historical price for ${instId}:`, error);
    }

    return null;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const marketClient = new MarketClient();
