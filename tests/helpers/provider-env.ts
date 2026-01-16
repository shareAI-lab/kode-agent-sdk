export type ProviderId = 'openai' | 'gemini' | 'anthropic';

export interface ProviderEnvConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  proxyUrl?: string;
}

export interface ProviderEnvResult {
  ok: boolean;
  config?: ProviderEnvConfig;
  reason?: string;
}

function getEnvValue(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function loadProviderEnv(provider: ProviderId): ProviderEnvResult {
  const prefix = provider.toUpperCase();
  const apiKey = getEnvValue([`${prefix}_API_KEY`]);
  if (!apiKey) {
    return { ok: false, reason: `缺少 ${prefix}_API_KEY` };
  }

  const model = getEnvValue([`${prefix}_MODEL_ID`, `${prefix}_MODEL`]);
  const baseUrl = getEnvValue([`${prefix}_BASE_URL`]);
  const proxyUrl = getEnvValue([`${prefix}_PROXY_URL`]);

  return {
    ok: true,
    config: {
      apiKey,
      model,
      baseUrl,
      proxyUrl,
    },
  };
}
