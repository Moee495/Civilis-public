export type LLMProvider = 'openai' | 'anthropic' | 'deepseek' | 'ollama';
export type LLMTextScope = 'default' | 'farewell' | 'observer';

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

interface TextCompletionOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  retries?: number;
  scope?: LLMTextScope;
}

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

function getGlobalConfig(): LLMConfig {
  const provider = (process.env.LLM_PROVIDER || 'openai') as LLMProvider;
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openai;

  return {
    provider,
    apiKey: process.env.LLM_API_KEY || '',
    baseUrl: process.env.LLM_API_URL || defaults.baseUrl,
    model: process.env.LLM_MODEL || defaults.model,
  };
}

function readScopedEnv(scope: LLMTextScope, suffix: 'PROVIDER' | 'API_KEY' | 'API_URL' | 'MODEL'): string {
  if (scope === 'default') return '';
  return process.env[`LLM_${scope.toUpperCase()}_${suffix}`] || '';
}

function getScopedConfig(scope: LLMTextScope = 'default'): LLMConfig {
  if (scope === 'default') {
    return getGlobalConfig();
  }

  const scopedProvider = readScopedEnv(scope, 'PROVIDER');
  const provider = (scopedProvider || process.env.LLM_PROVIDER || 'openai') as LLMProvider;
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openai;

  return {
    provider,
    apiKey: readScopedEnv(scope, 'API_KEY') || process.env.LLM_API_KEY || '',
    baseUrl: readScopedEnv(scope, 'API_URL') || process.env.LLM_API_URL || defaults.baseUrl,
    model: readScopedEnv(scope, 'MODEL') || process.env.LLM_MODEL || defaults.model,
  };
}

export function isLLMConfigured(scope: LLMTextScope = 'default'): boolean {
  const config = getScopedConfig(scope);
  return config.provider === 'ollama' ? Boolean(config.baseUrl) : Boolean(config.apiKey);
}

async function callOpenAICompatible(
  config: LLMConfig,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    throw new Error(`OpenAI-compatible API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(
  config: LLMConfig,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<string> {
  const systemMessage = messages.find((message) => message.role === 'system');
  const nonSystemMessages = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role, content: message.content }));

  const response = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      temperature,
      messages: nonSystemMessages,
      ...(systemMessage ? { system: systemMessage.content } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return data.content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('') ?? '';
}

async function callOllama(
  config: LLMConfig,
  messages: ChatMessage[],
  temperature: number,
  timeoutMs: number,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
      options: { temperature },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    throw new Error(`Ollama API error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as {
    message?: { content?: string };
  };
  return data.message?.content ?? '';
}

async function callLLM(
  config: LLMConfig,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<string> {
  switch (config.provider) {
    case 'anthropic':
      return callAnthropic(config, messages, maxTokens, temperature, timeoutMs);
    case 'ollama':
      return callOllama(config, messages, temperature, timeoutMs);
    case 'deepseek':
    case 'openai':
    default:
      return callOpenAICompatible(config, messages, maxTokens, temperature, timeoutMs);
  }
}

export async function llmText(options: TextCompletionOptions): Promise<string | null> {
  const scope = options.scope ?? 'default';

  if (!isLLMConfigured(scope)) {
    return null;
  }

  const config = getScopedConfig(scope);
  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: options.userPrompt },
  ];
  const retries = options.retries ?? 1;
  const maxTokens = options.maxTokens ?? 300;
  const temperature = options.temperature ?? 0.8;
  const timeoutMs = options.timeoutMs ?? 15_000;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const text = await callLLM(config, messages, maxTokens, temperature, timeoutMs);
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (error) {
      if (attempt === retries) {
        console.warn(`[ServerLLM:${config.provider}] text completion failed`, error);
        return null;
      }
      await sleep(750 * (attempt + 1));
    }
  }

  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
