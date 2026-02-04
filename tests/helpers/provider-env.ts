export type ProviderId = 'openai' | 'gemini' | 'anthropic' | 'glm' | 'minimax';

export interface ProviderEnvConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  proxyUrl?: string;
  openaiApi?: 'chat' | 'responses';
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  enablePdf?: boolean;
  enableIntertwined?: boolean;
}

export interface ProviderEnvResult {
  ok: boolean;
  config?: ProviderEnvConfig;
  reason?: string;
}

let cachedEnvFile: Record<string, string> | null = null;

function loadEnvFile(): Record<string, string> {
  if (cachedEnvFile) return cachedEnvFile;
  const fs = require('fs');
  const path = require('path');
  const filePath = process.env.DOTENV_CONFIG_PATH
    ? path.resolve(process.cwd(), process.env.DOTENV_CONFIG_PATH)
    : path.resolve(process.cwd(), '.env.test');
  if (!fs.existsSync(filePath)) {
    cachedEnvFile = {};
    return cachedEnvFile;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('export ')) {
      trimmed = trimmed.slice('export '.length).trim();
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) {
      env[key] = value;
    }
  }
  cachedEnvFile = env;
  return env;
}

function getEnvValue(keys: string[]): string | undefined {
  const envFile = loadEnvFile();
  for (const key of keys) {
    const fileValue = envFile[key];
    if (fileValue && fileValue.trim()) {
      return fileValue.trim();
    }
    const processValue = process.env[key];
    if (processValue && processValue.trim()) {
      return processValue.trim();
    }
  }
  return undefined;
}

function parseJsonEnv(value?: string): Record<string, any> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseEnableFlag(value?: string): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
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
  const openaiApi = getEnvValue([`${prefix}_API`, `${prefix}_OPENAI_API`, `${prefix}_OPENAI_API_MODE`]);
  const extraHeaders = parseJsonEnv(getEnvValue([`${prefix}_EXTRA_HEADERS`]));
  const extraBody = parseJsonEnv(getEnvValue([`${prefix}_EXTRA_BODY`]));
  const enablePdf = parseEnableFlag(getEnvValue([`${prefix}_ENABLE_PDF`]));
  const enableIntertwined = parseEnableFlag(getEnvValue([`${prefix}_ENABLE_INTERTWINED`]));

  return {
    ok: true,
    config: {
      apiKey,
      model,
      baseUrl,
      proxyUrl,
      openaiApi: openaiApi === 'responses' ? 'responses' : openaiApi === 'chat' ? 'chat' : undefined,
      extraHeaders: extraHeaders as Record<string, string> | undefined,
      extraBody,
      enablePdf,
      enableIntertwined,
    },
  };
}
