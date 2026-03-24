import * as crypto from 'crypto';

type PaymentApiKind = 'supported' | 'verify' | 'settle';

const BASE_URL = 'https://web3.okx.com';
const REQUEST_SPACING_MS = 350;
const MAX_429_RETRIES = 4;

const OFFICIAL_X402_PATHS: Record<PaymentApiKind, string[]> = {
  supported: ['/api/v6/x402/supported'],
  verify: ['/api/v6/x402/verify'],
  settle: ['/api/v6/x402/settle'],
};

const LEGACY_FALLBACK_PATHS: Record<PaymentApiKind, string[]> = {
  supported: [
    '/api/v6/payments/supported',
    '/api/v6/wallet/payments/supported',
    '/api/v6/wallet/x402/supported',
  ],
  verify: [
    '/api/v6/payments/verify',
    '/api/v6/wallet/payments/verify',
    '/api/v6/wallet/x402/verify',
  ],
  settle: [
    '/api/v6/payments/settle',
    '/api/v6/wallet/payments/settle',
    '/api/v6/wallet/x402/settle',
  ],
};

function useLegacyFallback(): boolean {
  return process.env.OKX_PAYMENTS_LEGACY_FALLBACK === 'true';
}

function getPathCandidates(kind: PaymentApiKind): string[] {
  return useLegacyFallback()
    ? [...OFFICIAL_X402_PATHS[kind], ...LEGACY_FALLBACK_PATHS[kind]]
    : OFFICIAL_X402_PATHS[kind];
}

function buildOkxHeaders(method: string, path: string, body: string): Record<string, string> {
  const apiKey = process.env.OKX_API_KEY ?? '';
  const secret = process.env.OKX_SECRET_KEY ?? '';
  const passphrase = process.env.OKX_PASSPHRASE ?? '';
  const projectId = process.env.OKX_PROJECT_ID ?? '';
  const bearerToken = process.env.OKX_PAYMENTS_BEARER_TOKEN ?? '';

  const timestamp = new Date().toISOString();
  const sign = secret
    ? crypto.createHmac('sha256', secret).update(timestamp + method.toUpperCase() + path + body).digest('base64')
    : '';

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  if (apiKey) headers['OK-ACCESS-KEY'] = apiKey;
  if (sign) headers['OK-ACCESS-SIGN'] = sign;
  if (timestamp) headers['OK-ACCESS-TIMESTAMP'] = timestamp;
  if (passphrase) headers['OK-ACCESS-PASSPHRASE'] = passphrase;
  if (projectId) headers['OK-ACCESS-PROJECT'] = projectId;
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  return headers;
}

function normalizeSupportedResponse(payload: unknown): {
  schemes: string[];
  networks: string[];
  assets: string[];
  combinations: Array<{ scheme: string; network: string; asset?: string }>;
} {
  const combinations = new Map<string, { scheme: string; network: string; asset?: string }>();

  const visit = (value: unknown): void => {
    if (!value) return;

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (typeof value !== 'object') return;

    const record = value as Record<string, unknown>;
    const scheme = ['scheme', 'paymentScheme', 'protocol']
      .map((key) => record[key])
      .find((item): item is string => typeof item === 'string' && item.trim().length > 0);
    const network = ['network', 'chain', 'chainId', 'chainIndex']
      .map((key) => record[key])
      .find((item): item is string | number => (typeof item === 'string' && item.trim().length > 0) || typeof item === 'number');
    const asset = ['asset', 'currency', 'tokenAddress']
      .map((key) => record[key])
      .find((item): item is string => typeof item === 'string' && item.trim().length > 0);

    if (scheme && network !== undefined) {
      const networkLabel = String(network);
      const key = `${scheme}:${networkLabel}:${asset ?? ''}`;
      combinations.set(key, { scheme, network: networkLabel, asset: asset ?? undefined });
    }

    Object.values(record).forEach(visit);
  };

  visit(payload);

  const normalized = Array.from(combinations.values());
  return {
    schemes: Array.from(new Set(normalized.map((item) => item.scheme))),
    networks: Array.from(new Set(normalized.map((item) => item.network))),
    assets: Array.from(new Set(normalized.map((item) => item.asset).filter((item): item is string => !!item))),
    combinations: normalized,
  };
}

export class OkxPaymentsClient {
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private supportedCache: {
    endpoint: string;
    payload: unknown;
    normalized: ReturnType<typeof normalizeSupportedResponse>;
    cachedAt: number;
  } | null = null;

  isConfigured(): boolean {
    return Boolean(
      (process.env.OKX_API_KEY &&
        process.env.OKX_SECRET_KEY &&
        process.env.OKX_PASSPHRASE &&
        process.env.OKX_PROJECT_ID) ||
      process.env.OKX_PAYMENTS_BEARER_TOKEN,
    );
  }

  async getSupported(): Promise<{
    endpoint: string;
    payload: unknown;
    normalized: ReturnType<typeof normalizeSupportedResponse>;
  }> {
    const now = Date.now();
    if (this.supportedCache && now - this.supportedCache.cachedAt < 60_000) {
      return {
        endpoint: this.supportedCache.endpoint,
        payload: this.supportedCache.payload,
        normalized: this.supportedCache.normalized,
      };
    }

    try {
      const result = await this.request('supported');
      const normalized = normalizeSupportedResponse(result.payload);
      this.supportedCache = {
        endpoint: result.endpoint,
        payload: result.payload,
        normalized,
        cachedAt: now,
      };
      return {
        endpoint: result.endpoint,
        payload: result.payload,
        normalized,
      };
    } catch (error) {
      if (this.supportedCache) {
        return {
          endpoint: this.supportedCache.endpoint,
          payload: this.supportedCache.payload,
          normalized: this.supportedCache.normalized,
        };
      }
      throw error;
    }
  }

  async verify(body: Record<string, unknown>): Promise<{ endpoint: string; payload: unknown }> {
    return this.request('verify', body);
  }

  async settle(body: Record<string, unknown>): Promise<{ endpoint: string; payload: unknown }> {
    return this.request('settle', body);
  }

  private async request(kind: PaymentApiKind, body?: Record<string, unknown>): Promise<{ endpoint: string; payload: unknown }> {
    if (!this.isConfigured()) {
      throw new Error('[OKX-Payments] Missing credentials');
    }

    const method = kind === 'supported' ? 'GET' : 'POST';
    const requestBody = body ? JSON.stringify(body) : '';
    let lastError = 'unknown error';

    for (const path of getPathCandidates(kind)) {
      try {
        return await this.executeWithThrottle(async () => {
          for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
            const response = await fetch(`${BASE_URL}${path}`, {
              method,
              headers: buildOkxHeaders(method, path, requestBody),
              body: method === 'POST' ? requestBody : undefined,
              signal: AbortSignal.timeout(15000),
            });

            const text = await response.text();
            let payload: unknown = text;
            try {
              payload = text ? JSON.parse(text) : {};
            } catch {
              payload = text;
            }

            if (response.ok) {
              return { endpoint: path, payload };
            }

            const message = typeof payload === 'object' && payload !== null && 'msg' in payload
              ? String((payload as Record<string, unknown>).msg)
              : `${response.status} ${response.statusText}`;

            if (response.status === 429 && attempt < MAX_429_RETRIES) {
              await sleep(this.getRetryDelayMs(response, attempt));
              continue;
            }

            throw new Error(`${path}: ${message}`);
          }

          throw new Error(`${path}: exceeded retry budget`);
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    throw new Error(`[OKX-Payments] ${kind} failed across all official endpoints: ${lastError}`);
  }

  private async executeWithThrottle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.requestQueue;
    let release!: () => void;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      const waitMs = this.lastRequestAt + REQUEST_SPACING_MS - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      const result = await operation();
      this.lastRequestAt = Date.now();
      return result;
    } finally {
      release();
    }
  }

  private getRetryDelayMs(response: Response, attempt: number): number {
    const retryAfterHeader = response.headers.get('retry-after');
    if (retryAfterHeader) {
      const retryAfterSeconds = Number(retryAfterHeader);
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
        return retryAfterSeconds * 1000;
      }
    }
    return REQUEST_SPACING_MS * Math.max(2, attempt + 2);
  }
}

export const okxPaymentsClient = new OkxPaymentsClient();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
