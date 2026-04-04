import {
  AnthropicProvider,
  GeminiProvider,
  ModelConfig,
  ModelProvider,
  OpenAIProvider,
} from '@shareai-lab/kode-sdk';

type DemoProvider = 'anthropic' | 'openai' | 'gemini' | 'glm';

function pickString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeProvider(value?: string): DemoProvider | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'anthropic' || normalized === 'openai' || normalized === 'gemini' || normalized === 'glm') {
    return normalized;
  }
  return undefined;
}

function detectDemoProvider(explicit?: string): DemoProvider {
  const preferred = normalizeProvider(explicit) ?? normalizeProvider(process.env.KODE_EXAMPLE_PROVIDER);
  if (preferred) {
    return preferred;
  }

  const openAiApiKey = pickString(process.env.OPENAI_API_KEY, process.env.OPENAI_API_TOKEN);
  const openAiModel = (process.env.OPENAI_MODEL_ID || '').toLowerCase();
  const openAiBaseUrl = (process.env.OPENAI_BASE_URL || '').toLowerCase();

  if (openAiApiKey && (openAiModel.startsWith('glm') || openAiBaseUrl.includes('bigmodel') || openAiBaseUrl.includes('zhipu'))) {
    return 'glm';
  }
  if (pickString(process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_TOKEN)) {
    return 'anthropic';
  }
  if (openAiApiKey) {
    return 'openai';
  }
  if (pickString(process.env.GEMINI_API_KEY, process.env.GEMINI_API_TOKEN)) {
    return 'gemini';
  }

  throw new Error(
    'No demo model provider was configured. Set KODE_EXAMPLE_PROVIDER or provide ANTHROPIC_*/OPENAI_*/GEMINI_* env vars.'
  );
}

export function createDemoModelConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  const provider = detectDemoProvider(overrides.provider);

  if (provider === 'anthropic') {
    const apiKey = pickString(overrides.apiKey, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_TOKEN);
    if (!apiKey) {
      throw new Error('Anthropic API key/token is required. Set ANTHROPIC_API_KEY or ANTHROPIC_API_TOKEN.');
    }
    return {
      provider,
      apiKey,
      model: pickString(overrides.model, process.env.ANTHROPIC_MODEL_ID, 'claude-sonnet-4-5-20250929')!,
      baseUrl: pickString(overrides.baseUrl, process.env.ANTHROPIC_BASE_URL),
      proxyUrl: pickString(overrides.proxyUrl),
      maxTokens: overrides.maxTokens,
      temperature: overrides.temperature,
      reasoningTransport: overrides.reasoningTransport,
      extraHeaders: overrides.extraHeaders,
      extraBody: overrides.extraBody,
      providerOptions: overrides.providerOptions,
      multimodal: overrides.multimodal,
      thinking: overrides.thinking,
    };
  }

  if (provider === 'gemini') {
    const apiKey = pickString(overrides.apiKey, process.env.GEMINI_API_KEY, process.env.GEMINI_API_TOKEN);
    if (!apiKey) {
      throw new Error('Gemini API key/token is required. Set GEMINI_API_KEY or GEMINI_API_TOKEN.');
    }
    return {
      provider,
      apiKey,
      model: pickString(overrides.model, process.env.GEMINI_MODEL_ID, 'gemini-2.0-flash')!,
      baseUrl: pickString(overrides.baseUrl, process.env.GEMINI_BASE_URL),
      proxyUrl: pickString(overrides.proxyUrl),
      maxTokens: overrides.maxTokens,
      temperature: overrides.temperature,
      reasoningTransport: overrides.reasoningTransport,
      extraHeaders: overrides.extraHeaders,
      extraBody: overrides.extraBody,
      providerOptions: overrides.providerOptions,
      multimodal: overrides.multimodal,
      thinking: overrides.thinking,
    };
  }

  const openAiApiKey = pickString(overrides.apiKey, process.env.OPENAI_API_KEY, process.env.OPENAI_API_TOKEN);
  if (!openAiApiKey) {
    throw new Error('OpenAI-compatible API key/token is required. Set OPENAI_API_KEY or OPENAI_API_TOKEN.');
  }

  const model = pickString(overrides.model, process.env.OPENAI_MODEL_ID, provider === 'glm' ? 'glm-5' : 'gpt-4o')!;
  const baseUrl = pickString(overrides.baseUrl, process.env.OPENAI_BASE_URL);

  if (provider === 'glm' && !baseUrl) {
    throw new Error('GLM requires OPENAI_BASE_URL (for example https://open.bigmodel.cn/api/paas/v4/).');
  }

  return {
    provider,
    apiKey: openAiApiKey,
    model,
    baseUrl,
    proxyUrl: pickString(overrides.proxyUrl),
    maxTokens: overrides.maxTokens,
    temperature: overrides.temperature,
    reasoningTransport: overrides.reasoningTransport,
    extraHeaders: overrides.extraHeaders,
    extraBody: overrides.extraBody,
    providerOptions: overrides.providerOptions,
    multimodal: overrides.multimodal,
    thinking: overrides.thinking,
  };
}

export function createDemoModelProvider(config: ModelConfig): ModelProvider {
  const resolved = createDemoModelConfig(config);

  if (resolved.provider === 'anthropic') {
    return new AnthropicProvider(resolved.apiKey!, resolved.model, resolved.baseUrl, resolved.proxyUrl, {
      reasoningTransport: resolved.reasoningTransport,
      extraHeaders: resolved.extraHeaders,
      extraBody: resolved.extraBody,
      providerOptions: resolved.providerOptions,
      multimodal: resolved.multimodal,
      thinking: resolved.thinking,
    });
  }

  if (resolved.provider === 'gemini') {
    return new GeminiProvider(resolved.apiKey!, resolved.model, resolved.baseUrl, resolved.proxyUrl, {
      reasoningTransport: resolved.reasoningTransport,
      extraHeaders: resolved.extraHeaders,
      extraBody: resolved.extraBody,
      providerOptions: resolved.providerOptions,
      multimodal: resolved.multimodal,
      thinking: resolved.thinking,
    });
  }

  if (resolved.provider === 'glm') {
    return new OpenAIProvider(resolved.apiKey!, resolved.model, resolved.baseUrl, resolved.proxyUrl, {
      reasoningTransport: resolved.reasoningTransport ?? 'provider',
      reasoning: {
        fieldName: 'reasoning_content',
        requestParams: { thinking: { type: 'enabled', clear_thinking: false } },
      },
      extraHeaders: resolved.extraHeaders,
      extraBody: resolved.extraBody,
      providerOptions: resolved.providerOptions,
      multimodal: resolved.multimodal,
      thinking: resolved.thinking,
    });
  }

  return new OpenAIProvider(resolved.apiKey!, resolved.model, resolved.baseUrl, resolved.proxyUrl, {
    reasoningTransport: resolved.reasoningTransport,
    extraHeaders: resolved.extraHeaders,
    extraBody: resolved.extraBody,
    providerOptions: resolved.providerOptions,
    multimodal: resolved.multimodal,
    thinking: resolved.thinking,
  });
}
