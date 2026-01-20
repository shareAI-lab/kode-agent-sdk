/**
 * Usage Statistics Module
 *
 * Unified usage tracking, cache metrics, and cost calculation
 * across all supported model providers.
 */

/**
 * Unified usage statistics for all providers.
 * Normalized from provider-specific usage formats.
 */
export interface UsageStatistics {
  // Core token counts
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;

  // Reasoning/thinking tokens (separate from output)
  reasoningTokens?: number;

  // Cache metrics
  cache: CacheMetrics;

  // Cost calculation
  cost: CostBreakdown;

  // Request metadata
  request: RequestMetrics;

  // Provider-specific raw usage (for debugging)
  raw?: Record<string, unknown>;
}

/**
 * Cache performance metrics.
 */
export interface CacheMetrics {
  // Tokens written to cache this request
  cacheCreationTokens: number;

  // Tokens read from cache (cache hits)
  cacheReadTokens: number;

  // Estimated cost savings from cache
  cacheSavingsEstimate?: number;

  // Provider-specific cache details
  provider: {
    anthropic?: {
      breakpointsUsed: number;  // 0-4
      ttlUsed: '5m' | '1h';
    };
    gemini?: {
      cachedContentName?: string;
      implicitCacheHit: boolean;
    };
    openai?: {
      automaticCacheHit: boolean;
    };
    deepseek?: {
      prefixCacheHit: boolean;
    };
    qwen?: {
      cacheHit: boolean;
    };
  };
}

/**
 * Cost breakdown in USD.
 */
export interface CostBreakdown {
  // Input token cost (after cache discounts)
  inputCost: number;

  // Output token cost (includes reasoning)
  outputCost: number;

  // Cache write cost (Anthropic: 1.25x for 5m, 2x for 1h)
  cacheWriteCost: number;

  // Total cost
  totalCost: number;

  // Savings from cache
  cacheSavings: number;

  // Currency (always USD)
  currency: 'USD';
}

/**
 * Request performance metrics.
 */
export interface RequestMetrics {
  // Request timing
  startTime: number;
  endTime: number;
  latencyMs: number;

  // First token timing (streaming only)
  timeToFirstTokenMs?: number;

  // Throughput
  tokensPerSecond?: number;

  // Request ID from provider
  requestId?: string;

  // Model actually used (important for OpenRouter fallbacks)
  modelUsed: string;

  // Stop reason
  stopReason?: string;

  // Number of retries
  retryCount?: number;
}

/**
 * Model pricing information (per 1M tokens in USD).
 */
export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  reasoning?: number;
}

/**
 * Provider pricing table (per 1M tokens).
 */
export const PROVIDER_PRICING: Record<string, Record<string, ModelPricing>> = {
  anthropic: {
    'claude-opus-4-5': {
      input: 5.0,
      output: 25.0,
      cacheWrite: 6.25,  // 5m TTL: 1.25x input
      cacheRead: 0.5,    // 10% of input
    },
    'claude-opus-4-5-1h': {
      input: 5.0,
      output: 25.0,
      cacheWrite: 10.0,  // 1h TTL: 2x input
      cacheRead: 0.5,
    },
    'claude-sonnet-4-5': {
      input: 3.0,
      output: 15.0,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    },
    'claude-haiku-4-5': {
      input: 1.0,
      output: 5.0,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    },
  },
  openai: {
    'gpt-5.2': {
      input: 5.0,
      output: 15.0,
      cacheRead: 1.25,  // 75% discount
    },
    'gpt-4.1': {
      input: 2.0,
      output: 8.0,
      cacheRead: 0.5,
    },
  },
  gemini: {
    'gemini-3-pro': {
      input: 2.5,
      output: 10.0,
      cacheRead: 0.625,  // 75% discount
    },
    'gemini-3-flash': {
      input: 0.075,
      output: 0.3,
      cacheRead: 0.01875,
    },
  },
  deepseek: {
    'deepseek-reasoner': {
      input: 0.28,
      output: 1.10,
      cacheRead: 0.028,  // 90% discount
    },
    'deepseek-chat': {
      input: 0.14,
      output: 0.28,
      cacheRead: 0.014,
    },
  },
  qwen: {
    'qwen3-max': {
      input: 0.80,
      output: 2.00,
    },
    'qwen3-plus': {
      input: 0.50,
      output: 1.50,
    },
  },
};

/**
 * Create empty usage statistics.
 */
export function createEmptyUsage(): UsageStatistics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cache: {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      provider: {},
    },
    cost: {
      inputCost: 0,
      outputCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      cacheSavings: 0,
      currency: 'USD',
    },
    request: {
      startTime: 0,
      endTime: 0,
      latencyMs: 0,
      modelUsed: '',
    },
  };
}

/**
 * Calculate cost based on usage and pricing.
 */
export function calculateCost(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
  },
  pricing: ModelPricing,
  cacheTtl?: '5m' | '1h'
): CostBreakdown {
  const perMillionFactor = 1_000_000;

  // Calculate raw input cost (before cache)
  const rawInputCost = (usage.inputTokens / perMillionFactor) * pricing.input;

  // Calculate cache costs
  const cacheReadCost = pricing.cacheRead
    ? ((usage.cacheReadTokens || 0) / perMillionFactor) * pricing.cacheRead
    : 0;

  let cacheWriteCost = 0;
  if (usage.cacheCreationTokens && pricing.cacheWrite) {
    const multiplier = cacheTtl === '1h' ? 2.0 : 1.25;
    cacheWriteCost = ((usage.cacheCreationTokens) / perMillionFactor) * pricing.input * multiplier;
  }

  // Actual input cost = raw - cached tokens + cache read cost
  const cachedInputTokens = usage.cacheReadTokens || 0;
  const nonCachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  const inputCost = (nonCachedInputTokens / perMillionFactor) * pricing.input + cacheReadCost;

  // Output cost
  const outputCost = (usage.outputTokens / perMillionFactor) * pricing.output;

  // Reasoning cost (if separate pricing)
  const reasoningCost = pricing.reasoning && usage.reasoningTokens
    ? (usage.reasoningTokens / perMillionFactor) * pricing.reasoning
    : 0;

  // Total cost
  const totalCost = inputCost + outputCost + cacheWriteCost + reasoningCost;

  // Cache savings = what we would have paid - what we actually paid
  const cacheSavings = cachedInputTokens > 0
    ? (cachedInputTokens / perMillionFactor) * pricing.input - cacheReadCost
    : 0;

  return {
    inputCost: Math.round(inputCost * 100000) / 100000,  // 5 decimal precision
    outputCost: Math.round((outputCost + reasoningCost) * 100000) / 100000,
    cacheWriteCost: Math.round(cacheWriteCost * 100000) / 100000,
    totalCost: Math.round(totalCost * 100000) / 100000,
    cacheSavings: Math.round(cacheSavings * 100000) / 100000,
    currency: 'USD',
  };
}

/**
 * Normalize Anthropic usage to unified format.
 */
export function normalizeAnthropicUsage(
  raw: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  model: string,
  startTime: number,
  requestId?: string,
  cacheTtl?: '5m' | '1h'
): UsageStatistics {
  const inputTokens = raw.input_tokens || 0;
  const outputTokens = raw.output_tokens || 0;
  const cacheCreationTokens = raw.cache_creation_input_tokens || 0;
  const cacheReadTokens = raw.cache_read_input_tokens || 0;

  // Determine model key for pricing
  const modelKey = model.includes('opus') ? 'claude-opus-4-5'
    : model.includes('sonnet') ? 'claude-sonnet-4-5'
    : 'claude-haiku-4-5';

  const pricing = cacheTtl === '1h'
    ? PROVIDER_PRICING.anthropic[`${modelKey}-1h`] || PROVIDER_PRICING.anthropic[modelKey]
    : PROVIDER_PRICING.anthropic[modelKey];

  const cost = pricing
    ? calculateCost({ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }, pricing, cacheTtl)
    : createEmptyUsage().cost;

  const endTime = Date.now();

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    cache: {
      cacheCreationTokens,
      cacheReadTokens,
      cacheSavingsEstimate: cost.cacheSavings,
      provider: {
        anthropic: {
          breakpointsUsed: 0,  // Inferred from request
          ttlUsed: cacheTtl || '5m',
        },
      },
    },
    cost,
    request: {
      startTime,
      endTime,
      latencyMs: endTime - startTime,
      requestId,
      modelUsed: model,
    },
    raw,
  };
}

/**
 * Normalize OpenAI usage to unified format.
 */
export function normalizeOpenAIUsage(
  raw: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  },
  model: string,
  api: 'chat' | 'responses',
  startTime: number,
  requestId?: string
): UsageStatistics {
  const inputTokens = raw.prompt_tokens || 0;
  const outputTokens = raw.completion_tokens || 0;
  const cacheReadTokens = raw.prompt_tokens_details?.cached_tokens || 0;
  const reasoningTokens = raw.completion_tokens_details?.reasoning_tokens || 0;

  const modelKey = model.includes('gpt-5') ? 'gpt-5.2' : 'gpt-4.1';
  const pricing = PROVIDER_PRICING.openai[modelKey];

  const cost = pricing
    ? calculateCost({ inputTokens, outputTokens, cacheReadTokens }, pricing)
    : createEmptyUsage().cost;

  const endTime = Date.now();

  return {
    inputTokens,
    outputTokens,
    totalTokens: raw.total_tokens || (inputTokens + outputTokens),
    reasoningTokens: reasoningTokens || undefined,
    cache: {
      cacheCreationTokens: 0,
      cacheReadTokens,
      cacheSavingsEstimate: cost.cacheSavings,
      provider: {
        openai: {
          automaticCacheHit: cacheReadTokens > 0,
        },
      },
    },
    cost,
    request: {
      startTime,
      endTime,
      latencyMs: endTime - startTime,
      requestId,
      modelUsed: model,
    },
    raw,
  };
}

/**
 * Normalize Gemini usage to unified format.
 */
export function normalizeGeminiUsage(
  raw: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  },
  model: string,
  startTime: number,
  cachedContentName?: string
): UsageStatistics {
  const inputTokens = raw.promptTokenCount || 0;
  const outputTokens = raw.candidatesTokenCount || 0;
  const cacheReadTokens = raw.cachedContentTokenCount || 0;
  const reasoningTokens = raw.thoughtsTokenCount || 0;

  const modelKey = model.includes('pro') ? 'gemini-3-pro' : 'gemini-3-flash';
  const pricing = PROVIDER_PRICING.gemini[modelKey];

  const cost = pricing
    ? calculateCost({ inputTokens, outputTokens, cacheReadTokens }, pricing)
    : createEmptyUsage().cost;

  const endTime = Date.now();

  return {
    inputTokens,
    outputTokens,
    totalTokens: raw.totalTokenCount || (inputTokens + outputTokens),
    reasoningTokens: reasoningTokens || undefined,
    cache: {
      cacheCreationTokens: 0,
      cacheReadTokens,
      cacheSavingsEstimate: cost.cacheSavings,
      provider: {
        gemini: {
          cachedContentName,
          implicitCacheHit: cacheReadTokens > 0 && !cachedContentName,
        },
      },
    },
    cost,
    request: {
      startTime,
      endTime,
      latencyMs: endTime - startTime,
      modelUsed: model,
    },
    raw,
  };
}

/**
 * Normalize DeepSeek usage to unified format.
 */
export function normalizeDeepSeekUsage(
  raw: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  },
  model: string,
  startTime: number,
  requestId?: string
): UsageStatistics {
  const inputTokens = raw.prompt_tokens || 0;
  const outputTokens = raw.completion_tokens || 0;
  const cacheReadTokens = raw.prompt_cache_hit_tokens || 0;

  const modelKey = model.includes('reasoner') ? 'deepseek-reasoner' : 'deepseek-chat';
  const pricing = PROVIDER_PRICING.deepseek[modelKey];

  const cost = pricing
    ? calculateCost({ inputTokens, outputTokens, cacheReadTokens }, pricing)
    : createEmptyUsage().cost;

  const endTime = Date.now();

  return {
    inputTokens,
    outputTokens,
    totalTokens: raw.total_tokens || (inputTokens + outputTokens),
    cache: {
      cacheCreationTokens: 0,
      cacheReadTokens,
      cacheSavingsEstimate: cost.cacheSavings,
      provider: {
        deepseek: {
          prefixCacheHit: cacheReadTokens > 0,
        },
      },
    },
    cost,
    request: {
      startTime,
      endTime,
      latencyMs: endTime - startTime,
      requestId,
      modelUsed: model,
    },
    raw,
  };
}

/**
 * Aggregate multiple usage statistics.
 */
export function aggregateUsage(usages: UsageStatistics[]): UsageStatistics {
  const aggregated = createEmptyUsage();

  for (const usage of usages) {
    aggregated.inputTokens += usage.inputTokens;
    aggregated.outputTokens += usage.outputTokens;
    aggregated.totalTokens += usage.totalTokens;
    aggregated.reasoningTokens = (aggregated.reasoningTokens || 0) + (usage.reasoningTokens || 0);

    aggregated.cache.cacheCreationTokens += usage.cache.cacheCreationTokens;
    aggregated.cache.cacheReadTokens += usage.cache.cacheReadTokens;
    aggregated.cache.cacheSavingsEstimate = (aggregated.cache.cacheSavingsEstimate || 0) +
      (usage.cache.cacheSavingsEstimate || 0);

    aggregated.cost.inputCost += usage.cost.inputCost;
    aggregated.cost.outputCost += usage.cost.outputCost;
    aggregated.cost.cacheWriteCost += usage.cost.cacheWriteCost;
    aggregated.cost.totalCost += usage.cost.totalCost;
    aggregated.cost.cacheSavings += usage.cost.cacheSavings;
  }

  // Average latency
  if (usages.length > 0) {
    aggregated.request.latencyMs = usages.reduce((sum, u) => sum + u.request.latencyMs, 0) / usages.length;
  }

  return aggregated;
}

/**
 * Format usage as human-readable string.
 */
export function formatUsageString(usage: UsageStatistics): string {
  const parts: string[] = [];

  parts.push(`Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`);

  if (usage.reasoningTokens) {
    parts.push(`(${usage.reasoningTokens} reasoning)`);
  }

  if (usage.cache.cacheReadTokens > 0) {
    parts.push(`Cache hit: ${usage.cache.cacheReadTokens} tokens`);
  }

  if (usage.cost.totalCost > 0) {
    parts.push(`Cost: $${usage.cost.totalCost.toFixed(5)}`);
  }

  if (usage.cost.cacheSavings > 0) {
    parts.push(`(saved: $${usage.cost.cacheSavings.toFixed(5)})`);
  }

  if (usage.request.latencyMs > 0) {
    parts.push(`Latency: ${usage.request.latencyMs}ms`);
  }

  return parts.join(' | ');
}
