/**
 * Multi-Provider LLM Client for Agent Decision Making
 *
 * Supports:
 *   - OpenAI / OpenAI-compatible (default)
 *   - Anthropic Claude
 *   - Ollama (local)
 *   - Any OpenAI-compatible endpoint (DeepSeek, Groq, Together, etc.)
 *
 * Configuration via environment variables:
 *   LLM_PROVIDER=openai|anthropic|deepseek|ollama   (default: openai)
 *   LLM_API_KEY=your-key                            (ollama 可留空)
 *   LLM_API_URL=https://...               (override base URL)
 *   LLM_MODEL=model-name                  (provider-specific default)
 *
 * Phase 2 (SPEC_12): External agents can specify their own provider
 * via AgentPassport.llmConfig when onboarding.
 */

// ═══════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════

export type LLMProvider = 'openai' | 'anthropic' | 'deepseek' | 'ollama';
export type LLMScope = 'default' | 'social';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ═══════════════════════════════════════════════════
// Provider defaults
// ═══════════════════════════════════════════════════

const PROVIDER_DEFAULTS: Record<LLMProvider, { baseUrl: string; model: string }> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'llama3',
  },
};

// ═══════════════════════════════════════════════════
// Global config (from env)
// ═══════════════════════════════════════════════════

function getGlobalConfig(): LLMConfig {
  const provider = (process.env.LLM_PROVIDER || 'openai') as LLMProvider;
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;

  return {
    provider,
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_API_URL || defaults.baseUrl,
    model: process.env.LLM_MODEL || defaults.model,
  };
}

function readScopedEnv(scope: LLMScope, suffix: 'PROVIDER' | 'API_KEY' | 'API_URL' | 'MODEL'): string {
  if (scope === 'default') return '';
  return process.env[`LLM_${scope.toUpperCase()}_${suffix}`] || '';
}

export function getScopedConfig(scope: LLMScope = 'default'): LLMConfig {
  if (scope === 'default') {
    return getGlobalConfig();
  }

  const scopedProvider = readScopedEnv(scope, 'PROVIDER');
  const provider = (scopedProvider || process.env.LLM_PROVIDER || 'openai') as LLMProvider;
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;

  return {
    provider,
    apiKey: readScopedEnv(scope, 'API_KEY') || process.env.LLM_API_KEY || '',
    baseUrl: readScopedEnv(scope, 'API_URL') || process.env.LLM_API_URL || defaults.baseUrl,
    model: readScopedEnv(scope, 'MODEL') || process.env.LLM_MODEL || defaults.model,
  };
}

export function isLLMConfigured(configOverride?: Partial<LLMConfig>): boolean {
  const config = { ...getGlobalConfig(), ...configOverride };
  return config.provider === 'ollama' ? Boolean(config.baseUrl) : Boolean(config.apiKey);
}

export function isScopedLLMConfigured(scope: LLMScope): boolean {
  const config = getScopedConfig(scope);
  return config.provider === 'ollama' ? Boolean(config.baseUrl) : Boolean(config.apiKey);
}

// ═══════════════════════════════════════════════════
// OpenAI / OpenAI-compatible provider
// ═══════════════════════════════════════════════════

async function callOpenAI(
  config: LLMConfig,
  messages: ChatMessage[],
  jsonMode: boolean,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => 'unknown');
    throw new Error(`OpenAI API error ${res.status}: ${errorText}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices[0]?.message?.content || '';
}

// ═══════════════════════════════════════════════════
// Anthropic Claude provider
// ═══════════════════════════════════════════════════

async function callAnthropic(
  config: LLMConfig,
  messages: ChatMessage[],
  _jsonMode: boolean,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  // Anthropic API: system goes in a separate field, not in messages
  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: maxTokens,
    temperature,
    messages: nonSystemMessages,
  };

  if (systemMsg) {
    body.system = systemMsg.content;
  }

  const res = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => 'unknown');
    throw new Error(`Anthropic API error ${res.status}: ${errorText}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  return data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// ═══════════════════════════════════════════════════
// Ollama provider (local, OpenAI-compatible)
// ═══════════════════════════════════════════════════

async function callOllama(
  config: LLMConfig,
  messages: ChatMessage[],
  jsonMode: boolean,
  _maxTokens: number,
  temperature: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
    options: { temperature },
  };

  if (jsonMode) {
    body.format = 'json';
  }

  const res = await fetch(`${config.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => 'unknown');
    throw new Error(`Ollama API error ${res.status}: ${errorText}`);
  }

  const data = (await res.json()) as {
    message: { content: string };
  };

  return data.message?.content || '';
}

// ═══════════════════════════════════════════════════
// Unified dispatcher
// ═══════════════════════════════════════════════════

async function callLLM(
  config: LLMConfig,
  messages: ChatMessage[],
  jsonMode: boolean,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  switch (config.provider) {
    case 'anthropic':
      return callAnthropic(config, messages, jsonMode, maxTokens, temperature);
    case 'ollama':
      return callOllama(config, messages, jsonMode, maxTokens, temperature);
    case 'deepseek':  // DeepSeek uses OpenAI-compatible API
    case 'openai':
    default:
      return callOpenAI(config, messages, jsonMode, maxTokens, temperature);
  }
}

// ═══════════════════════════════════════════════════
// Public API (backward-compatible interface)
// ═══════════════════════════════════════════════════

/**
 * Call LLM and parse response as JSON.
 * Handles markdown code fences and retry on parse failure.
 *
 * @param configOverride — Phase 2: external agents can pass their own LLM config
 */
export async function llmJson<T>(
  systemPrompt: string,
  userPrompt: string,
  retries = 2,
  configOverride?: Partial<LLMConfig>,
): Promise<T> {
  const config = { ...getGlobalConfig(), ...configOverride };

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await callLLM(config, messages, true, 500, 0.7);

      // Strip markdown code fences if present
      const cleaned = raw
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();

      return JSON.parse(cleaned) as T;
    } catch (err) {
      if (attempt === retries) {
        console.error(`[LLM:${config.provider}] All retries failed:`, err);
        throw err instanceof Error ? err : new Error(String(err));
      }
      console.warn(
        `[LLM:${config.provider}] Attempt ${attempt + 1} failed, retrying...`,
      );
      await sleep(1000 * (attempt + 1));
    }
  }

  return {} as T;
}

/**
 * Simple text completion (epitaphs, world event descriptions, etc.)
 *
 * @param configOverride — Phase 2: external agents can pass their own LLM config
 */
export async function llmText(
  systemPrompt: string,
  userPrompt: string,
  configOverride?: Partial<LLMConfig>,
): Promise<string> {
  const config = { ...getGlobalConfig(), ...configOverride };

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  try {
    return await callLLM(config, messages, false, 300, 0.8);
  } catch (err) {
    console.error(`[LLM:${config.provider}] Text completion failed:`, err);
    return '';
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
