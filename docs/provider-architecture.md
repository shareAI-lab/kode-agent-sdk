# Provider Architecture V2: 100-Point Best Practice Design

Based on comprehensive research of official documentation from Anthropic, OpenAI, Google Gemini, DeepSeek, Qwen, GLM, Kimi, Minimax, OpenRouter, Groq, and Cerebras.

## Executive Summary

This document defines a production-grade provider architecture that:
- Supports 11+ model providers with unified internal format
- Handles thinking/reasoning across all providers correctly
- Implements prompt caching with provider-specific strategies
- Provides typed error handling with retry logic
- Tracks usage statistics with cache metrics
- Supports agent resume/fork mechanisms seamlessly

---

## Part 1: Unified Type System

### 1.1 Core Message Types

```typescript
// core/types.ts

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  role: MessageRole;
  content: ContentBlock[];
  metadata?: MessageMetadata;
}

export interface MessageMetadata {
  // Original content blocks before any transformation
  content_blocks?: ContentBlock[];

  // How reasoning was transported
  transport?: ReasoningTransport;

  // Cache control for this message
  cacheControl?: CacheControl;

  // Message-level tracking
  messageId?: string;
  timestamp?: number;
}

export type ReasoningTransport = 'provider' | 'text' | 'omit';
```

### 1.2 Content Block Types

```typescript
// Unified content blocks - Anthropic-style as canonical format

export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | AudioBlock
  | FileBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface TextBlock {
  type: 'text';
  text: string;
  cacheControl?: CacheControl;
}

export interface ReasoningBlock {
  type: 'reasoning';
  reasoning: string;
  meta?: ReasoningMeta;
}

export interface ReasoningMeta {
  // Anthropic: signature for multi-turn verification
  signature?: string;

  // Gemini: thought signature for function calls
  thoughtSignature?: string;

  // OpenAI Responses: reasoning item ID for state persistence
  reasoningId?: string;

  // DeepSeek/Qwen: whether to include in next turn
  includeInHistory?: boolean;
}

export interface ImageBlock {
  type: 'image';
  // Source variants
  base64?: string;
  url?: string;
  file_id?: string;
  // Metadata
  mime_type?: string;
  detail?: 'low' | 'high' | 'auto';
}

export interface AudioBlock {
  type: 'audio';
  base64?: string;
  url?: string;
  mime_type?: string;
}

export interface FileBlock {
  type: 'file';
  base64?: string;
  url?: string;
  file_id?: string;
  filename?: string;
  mime_type?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  meta?: ToolUseMeta;
}

export interface ToolUseMeta {
  // For tracking parallel tool calls
  index?: number;
  // Provider-specific tool call ID format
  originalId?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}
```

### 1.3 Cache Control Types

```typescript
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';  // Anthropic extended TTL
}

export interface CacheMetrics {
  // Tokens written to cache this request
  cacheCreationTokens: number;

  // Tokens read from cache (cache hits)
  cacheReadTokens: number;

  // Cost savings from cache
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
  };
}
```

---

## Part 2: Provider-Specific Options

### 2.1 Provider Options Interface Hierarchy

```typescript
// Each provider has its own options type - no pseudo-abstraction

export interface BaseProviderOptions {
  // How to handle reasoning blocks
  reasoningTransport?: ReasoningTransport;

  // Proxy configuration
  proxyUrl?: string;

  // Request timeout in ms
  timeout?: number;
}

export interface AnthropicProviderOptions extends BaseProviderOptions {
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;  // Minimum 1024
  };

  // Beta features
  beta?: {
    interleavedThinking?: boolean;  // interleaved-thinking-2025-05-14
    filesApi?: boolean;  // files-api-2025-04-14
    extendedCacheTtl?: boolean;  // extended-cache-ttl-2025-04-11
  };

  // Cache strategy
  cache?: {
    breakpoints?: number;  // 1-4
    defaultTtl?: '5m' | '1h';
  };
}

export interface OpenAIProviderOptions extends BaseProviderOptions {
  // Which API to use
  api: 'chat' | 'responses';

  // For Responses API only
  responses?: {
    reasoning?: {
      effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    };
    store?: boolean;  // Enable state persistence
    previousResponseId?: string;  // For multi-turn
  };

  // Streaming options
  streamOptions?: {
    includeUsage?: boolean;
  };
}

export interface GeminiProviderOptions extends BaseProviderOptions {
  // Gemini 3.x thinking config
  thinking?: {
    level: 'minimal' | 'low' | 'medium' | 'high';
    includeThoughts?: boolean;
  };

  // Context caching
  cache?: {
    // Explicit cache name to use
    cachedContentName?: string;
    // Create new cache with TTL
    createCache?: {
      displayName: string;
      ttlSeconds: number;  // e.g., 3600
    };
  };

  // Media resolution for multimodal
  mediaResolution?: 'low' | 'medium' | 'high';
}

export interface DeepSeekProviderOptions extends BaseProviderOptions {
  thinking?: {
    enabled: boolean;
  };

  // DeepSeek uses automatic prefix caching
  // No explicit cache config needed
}

export interface QwenProviderOptions extends BaseProviderOptions {
  thinking?: {
    enabled: boolean;
    budget?: number;  // thinking_budget parameter
  };

  // Region selection
  region?: 'beijing' | 'singapore' | 'virginia';
}

export interface GLMProviderOptions extends BaseProviderOptions {
  thinking?: {
    enabled: boolean;
  };

  // Max 128 functions
  maxFunctions?: number;
}

export interface MinimaxProviderOptions extends BaseProviderOptions {
  // reasoning_split parameter
  reasoningSplit?: boolean;
}
```

---

## Part 3: Usage Statistics Module

### 3.1 Unified Usage Interface

```typescript
// core/usage.ts

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

  // Provider-specific raw usage
  raw?: Record<string, unknown>;
}

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

export interface RequestMetrics {
  // Request timing
  startTime: number;
  endTime: number;
  latencyMs: number;

  // First token timing
  timeToFirstTokenMs?: number;

  // Tokens per second
  tokensPerSecond?: number;

  // Request ID from provider
  requestId?: string;

  // Model actually used (important for OpenRouter fallbacks)
  modelUsed: string;

  // Stop reason
  stopReason?: string;
}
```

### 3.2 Usage Normalization Functions

```typescript
// providers/usage-normalizer.ts

export function normalizeAnthropicUsage(raw: any): UsageStatistics {
  return {
    inputTokens: raw.input_tokens || 0,
    outputTokens: raw.output_tokens || 0,
    totalTokens: (raw.input_tokens || 0) + (raw.output_tokens || 0) +
                 (raw.cache_creation_input_tokens || 0) +
                 (raw.cache_read_input_tokens || 0),

    cache: {
      cacheCreationTokens: raw.cache_creation_input_tokens || 0,
      cacheReadTokens: raw.cache_read_input_tokens || 0,
      provider: {
        anthropic: {
          breakpointsUsed: 0,  // Inferred from request
          ttlUsed: '5m',
        },
      },
    },

    // Cost calculation uses model-specific pricing
    cost: calculateAnthropicCost(raw),

    request: {
      startTime: 0,
      endTime: 0,
      latencyMs: 0,
      modelUsed: '',
    },

    raw,
  };
}

export function normalizeOpenAIUsage(raw: any, api: 'chat' | 'responses'): UsageStatistics {
  const details = raw.output_tokens_details || {};

  return {
    inputTokens: raw.prompt_tokens || raw.input_tokens || 0,
    outputTokens: raw.completion_tokens || raw.output_tokens || 0,
    totalTokens: raw.total_tokens || 0,

    reasoningTokens: details.reasoning_tokens || 0,

    cache: {
      cacheCreationTokens: 0,
      cacheReadTokens: raw.prompt_tokens_details?.cached_tokens || 0,
      provider: {
        openai: {
          automaticCacheHit: (raw.prompt_tokens_details?.cached_tokens || 0) > 0,
        },
      },
    },

    cost: calculateOpenAICost(raw, api),

    request: {
      startTime: 0,
      endTime: 0,
      latencyMs: 0,
      modelUsed: '',
    },

    raw,
  };
}

export function normalizeGeminiUsage(raw: any): UsageStatistics {
  return {
    inputTokens: raw.promptTokenCount || 0,
    outputTokens: raw.candidatesTokenCount || 0,
    totalTokens: raw.totalTokenCount || 0,

    reasoningTokens: raw.thoughtsTokenCount || 0,

    cache: {
      cacheCreationTokens: 0,
      cacheReadTokens: raw.cachedContentTokenCount || 0,
      provider: {
        gemini: {
          cachedContentName: undefined,
          implicitCacheHit: (raw.cachedContentTokenCount || 0) > 0,
        },
      },
    },

    cost: calculateGeminiCost(raw),

    request: {
      startTime: 0,
      endTime: 0,
      latencyMs: 0,
      modelUsed: '',
    },

    raw,
  };
}
```

---

## Part 4: Error Handling Hierarchy

### 4.1 Error Class Hierarchy

```typescript
// core/errors.ts

export abstract class ProviderError extends Error {
  abstract readonly code: ProviderErrorCode;
  abstract readonly retryable: boolean;

  readonly provider: string;
  readonly requestId?: string;
  readonly timestamp: number;

  constructor(message: string, provider: string, requestId?: string) {
    super(message);
    this.name = this.constructor.name;
    this.provider = provider;
    this.requestId = requestId;
    this.timestamp = Date.now();
  }

  toJSON(): ProviderErrorDetails {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      requestId: this.requestId,
      retryable: this.retryable,
      timestamp: this.timestamp,
    };
  }
}

export type ProviderErrorCode =
  | 'RATE_LIMIT'
  | 'AUTH_FAILED'
  | 'CONTEXT_LENGTH'
  | 'INVALID_REQUEST'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'CONTENT_FILTER'
  | 'MODEL_NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'SERVICE_UNAVAILABLE'
  | 'THINKING_SIGNATURE_INVALID';

export class RateLimitError extends ProviderError {
  readonly code = 'RATE_LIMIT' as const;
  readonly retryable = true;

  readonly retryAfter?: number;
  readonly limitType?: 'requests' | 'tokens';

  constructor(
    provider: string,
    retryAfter?: number,
    limitType?: 'requests' | 'tokens',
    requestId?: string
  ) {
    super(
      `Rate limit exceeded${retryAfter ? `, retry after ${retryAfter}s` : ''}`,
      provider,
      requestId
    );
    this.retryAfter = retryAfter;
    this.limitType = limitType;
  }
}

export class AuthenticationError extends ProviderError {
  readonly code = 'AUTH_FAILED' as const;
  readonly retryable = false;

  constructor(provider: string, requestId?: string) {
    super('Authentication failed - check API key', provider, requestId);
  }
}

export class ContextLengthError extends ProviderError {
  readonly code = 'CONTEXT_LENGTH' as const;
  readonly retryable = false;

  readonly maxTokens: number;
  readonly requestedTokens: number;

  constructor(
    provider: string,
    maxTokens: number,
    requestedTokens: number,
    requestId?: string
  ) {
    super(
      `Context length ${requestedTokens} exceeds maximum ${maxTokens}`,
      provider,
      requestId
    );
    this.maxTokens = maxTokens;
    this.requestedTokens = requestedTokens;
  }
}

export class ThinkingSignatureError extends ProviderError {
  readonly code = 'THINKING_SIGNATURE_INVALID' as const;
  readonly retryable = false;

  constructor(provider: string, requestId?: string) {
    super(
      'Thinking signature invalid - blocks may have been modified',
      provider,
      requestId
    );
  }
}

export class ServerError extends ProviderError {
  readonly code = 'SERVER_ERROR' as const;
  readonly retryable = true;

  readonly statusCode?: number;

  constructor(provider: string, statusCode?: number, requestId?: string) {
    super(
      `Server error${statusCode ? ` (${statusCode})` : ''}`,
      provider,
      requestId
    );
    this.statusCode = statusCode;
  }
}

export class ContentFilterError extends ProviderError {
  readonly code = 'CONTENT_FILTER' as const;
  readonly retryable = false;

  readonly category?: string;

  constructor(provider: string, category?: string, requestId?: string) {
    super(
      `Content filtered${category ? `: ${category}` : ''}`,
      provider,
      requestId
    );
    this.category = category;
  }
}
```

### 4.2 Error Parser

```typescript
// providers/error-parser.ts

export function parseProviderError(
  error: any,
  provider: string
): ProviderError {
  const statusCode = error.status || error.statusCode;
  const requestId = error.request_id || error.requestId;

  // Rate limit
  if (statusCode === 429) {
    const retryAfter = parseRetryAfter(error);
    return new RateLimitError(provider, retryAfter, undefined, requestId);
  }

  // Auth errors
  if (statusCode === 401 || statusCode === 403) {
    return new AuthenticationError(provider, requestId);
  }

  // Server errors (retryable)
  if (statusCode === 529 || statusCode >= 500) {
    return new ServerError(provider, statusCode, requestId);
  }

  // Context length
  if (error.code === 'context_length_exceeded' ||
      error.message?.includes('context') ||
      error.message?.includes('token')) {
    return new ContextLengthError(
      provider,
      error.max_tokens || 0,
      error.requested_tokens || 0,
      requestId
    );
  }

  // Content filter
  if (error.code === 'content_policy_violation' ||
      error.message?.includes('safety') ||
      error.message?.includes('filter')) {
    return new ContentFilterError(provider, error.category, requestId);
  }

  // Anthropic thinking signature
  if (error.message?.includes('signature')) {
    return new ThinkingSignatureError(provider, requestId);
  }

  // Default to server error
  return new ServerError(provider, statusCode, requestId);
}

function parseRetryAfter(error: any): number | undefined {
  const header = error.headers?.['retry-after'];
  if (header) {
    const seconds = parseInt(header, 10);
    if (!isNaN(seconds)) return seconds;
  }
  return undefined;
}
```

### 4.3 Retry Strategy

```typescript
// core/retry.ts

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitterFactor: 0.2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (error: ProviderError, attempt: number, delayMs: number) => void
): Promise<T> {
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const providerError = error instanceof ProviderError
        ? error
        : parseProviderError(error, 'unknown');

      lastError = providerError;

      // Don't retry non-retryable errors
      if (!providerError.retryable || attempt === config.maxRetries) {
        throw providerError;
      }

      // Calculate delay with exponential backoff and jitter
      let delay = Math.min(
        config.baseDelayMs * Math.pow(2, attempt),
        config.maxDelayMs
      );

      // Use retry-after header if available
      if (providerError instanceof RateLimitError && providerError.retryAfter) {
        delay = Math.max(delay, providerError.retryAfter * 1000);
      }

      // Add jitter
      const jitter = delay * config.jitterFactor * (Math.random() - 0.5);
      delay = Math.floor(delay + jitter);

      onRetry?.(providerError, attempt + 1, delay);

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## Part 5: Logging and Debugging Module

### 5.1 Logger Interface

```typescript
// core/logger.ts

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
  context?: Record<string, unknown>;

  // Request correlation
  requestId?: string;
  agentId?: string;
  sessionId?: string;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;

  // Create child logger with additional context
  child(context: Record<string, unknown>): Logger;
}

export interface ProviderLogger extends Logger {
  // Log request/response pairs
  logRequest(request: ProviderRequest): void;
  logResponse(response: ProviderResponse, durationMs: number): void;
  logError(error: ProviderError): void;

  // Log streaming events
  logStreamEvent(event: StreamEvent): void;

  // Log cache operations
  logCacheHit(tokens: number): void;
  logCacheWrite(tokens: number, ttl: string): void;
}
```

### 5.2 Debug Configuration

```typescript
// core/debug.ts

export interface DebugConfig {
  // Enable verbose logging
  verbose: boolean;

  // Log raw API requests/responses
  logRawRequests: boolean;
  logRawResponses: boolean;

  // Log thinking/reasoning content
  logThinking: boolean;

  // Log token counts
  logTokenUsage: boolean;

  // Log cache operations
  logCache: boolean;

  // Log retry attempts
  logRetries: boolean;

  // Redact sensitive data (API keys, etc.)
  redactSensitive: boolean;

  // Max content length in logs
  maxContentLength: number;
}

export const DEFAULT_DEBUG_CONFIG: DebugConfig = {
  verbose: false,
  logRawRequests: false,
  logRawResponses: false,
  logThinking: false,
  logTokenUsage: true,
  logCache: true,
  logRetries: true,
  redactSensitive: true,
  maxContentLength: 500,
};
```

### 5.3 Audit Trail

```typescript
// core/audit.ts

export interface AuditRecord {
  id: string;
  timestamp: number;

  // Request info
  provider: string;
  model: string;
  requestId?: string;

  // Token usage
  usage: UsageStatistics;

  // Cache performance
  cacheHit: boolean;
  cacheSavings?: number;

  // Error info
  error?: ProviderErrorDetails;

  // Timing
  latencyMs: number;
  timeToFirstTokenMs?: number;

  // Agent context
  agentId?: string;
  sessionId?: string;
  stepNumber?: number;
}

export interface AuditStore {
  record(audit: AuditRecord): Promise<void>;
  query(filter: AuditFilter): Promise<AuditRecord[]>;
  aggregate(filter: AuditFilter): Promise<AuditAggregation>;
}

export interface AuditAggregation {
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  cacheHitRate: number;
  averageLatencyMs: number;
  errorRate: number;

  byProvider: Map<string, {
    requests: number;
    tokens: number;
    cost: number;
  }>;

  byModel: Map<string, {
    requests: number;
    tokens: number;
    cost: number;
  }>;
}
```

---

## Part 6: Provider Interface

### 6.1 Minimal Provider Interface

```typescript
// providers/types.ts

export interface ModelProvider<TOptions extends BaseProviderOptions = BaseProviderOptions> {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  // Core operations
  complete(
    messages: Message[],
    options?: CompletionOptions
  ): Promise<ModelResponse>;

  stream(
    messages: Message[],
    options?: CompletionOptions
  ): AsyncIterable<StreamChunk>;

  // Provider configuration
  configure(options: Partial<TOptions>): void;
  getConfig(): TOptions;
}

export interface ProviderCapabilities {
  // Feature support
  supportsThinking: boolean;
  supportsInterleavedThinking: boolean;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsFiles: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsCache: boolean;

  // Limits
  maxContextTokens: number;
  maxOutputTokens: number;

  // Cache requirements
  minCacheableTokens?: number;
  maxCacheBreakpoints?: number;
}

export interface ModelResponse {
  role: 'assistant';
  content: ContentBlock[];
  usage: UsageStatistics;
  stopReason?: string;
}

export interface StreamChunk {
  type: StreamEventType;
  index?: number;
  delta?: ContentBlockDelta;
  block?: ContentBlock;
  usage?: Partial<UsageStatistics>;
}

export type StreamEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'error'
  | 'ping';
```

### 6.2 Optional Extension Interfaces

```typescript
// providers/extensions.ts

export interface FileUploadProvider {
  uploadFile(input: FileUploadInput): Promise<FileUploadResult>;
  listFiles?(): Promise<FileInfo[]>;
  deleteFile?(fileId: string): Promise<void>;
}

export interface TokenCountProvider {
  countTokens(messages: Message[]): Promise<number>;
  countTokensSync?(text: string): number;
}

export interface CacheProvider {
  createCache(input: CacheCreateInput): Promise<CacheInfo>;
  useCache(cacheId: string): void;
  clearCache?(cacheId: string): Promise<void>;
  listCaches?(): Promise<CacheInfo[]>;
}
```

---

## Part 7: Message Transformation (Pure Functions)

### 7.1 Internal to Provider Format

```typescript
// providers/transformers/anthropic.ts

export function toAnthropicMessages(
  messages: Message[],
  options: AnthropicProviderOptions
): AnthropicMessage[] {
  return messages.map(msg => toAnthropicMessage(msg, options));
}

function toAnthropicMessage(
  msg: Message,
  options: AnthropicProviderOptions
): AnthropicMessage {
  const blocks = getMessageBlocks(msg);

  return {
    role: msg.role === 'system' ? 'user' : msg.role,
    content: blocks.map(block => toAnthropicBlock(block, options)),
  };
}

function toAnthropicBlock(
  block: ContentBlock,
  options: AnthropicProviderOptions
): AnthropicBlock {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: block.text,
        ...(block.cacheControl && { cache_control: block.cacheControl }),
      };

    case 'reasoning':
      // Only include if transport is 'provider'
      if (options.reasoningTransport !== 'provider') {
        throw new Error('Reasoning block with non-provider transport');
      }
      return {
        type: 'thinking',
        thinking: block.reasoning,
        ...(block.meta?.signature && { signature: block.meta.signature }),
      };

    case 'image':
      return toAnthropicImageBlock(block);

    case 'file':
      return toAnthropicFileBlock(block);

    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };

    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: formatToolResultContent(block.content),
        ...(block.is_error && { is_error: true }),
      };

    default:
      throw new Error(`Unsupported block type: ${(block as any).type}`);
  }
}
```

### 7.2 Provider Response to Internal Format

```typescript
// providers/transformers/anthropic-response.ts

export function fromAnthropicResponse(
  response: AnthropicAPIResponse
): ModelResponse {
  return {
    role: 'assistant',
    content: response.content.map(fromAnthropicBlock),
    usage: normalizeAnthropicUsage(response.usage),
    stopReason: response.stop_reason,
  };
}

function fromAnthropicBlock(block: AnthropicResponseBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };

    case 'thinking':
      return {
        type: 'reasoning',
        reasoning: block.thinking,
        meta: {
          signature: block.signature,
        },
      };

    case 'redacted_thinking':
      // Preserve redacted blocks for multi-turn
      return {
        type: 'reasoning',
        reasoning: '[redacted]',
        meta: {
          signature: block.data,  // Encrypted data
        },
      };

    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };

    default:
      throw new Error(`Unknown block type: ${(block as any).type}`);
  }
}
```

---

## Part 8: Resume/Fork Compatibility

### 8.1 Safe Fork Point Detection

```typescript
// core/fork.ts

export interface ForkPoint {
  messageIndex: number;
  isSafe: boolean;
  reason?: string;
}

export function findSafeForkPoints(messages: Message[]): ForkPoint[] {
  const points: ForkPoint[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const point = analyzeForkSafety(msg, i, messages);
    points.push(point);
  }

  return points;
}

function analyzeForkSafety(
  msg: Message,
  index: number,
  messages: Message[]
): ForkPoint {
  // User messages are always safe fork points
  if (msg.role === 'user') {
    return { messageIndex: index, isSafe: true };
  }

  // Assistant messages without tool_use are safe
  if (msg.role === 'assistant') {
    const hasToolUse = msg.content.some(b => b.type === 'tool_use');
    if (!hasToolUse) {
      return { messageIndex: index, isSafe: true };
    }

    // Check if all tool calls have results
    const toolUseIds = msg.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map(b => b.id);

    const nextMsg = messages[index + 1];
    if (nextMsg?.role === 'user') {
      const resultIds = nextMsg.content
        .filter((b): b is ToolResultBlock => b.type === 'tool_result')
        .map(b => b.tool_use_id);

      const allHaveResults = toolUseIds.every(id => resultIds.includes(id));
      if (allHaveResults) {
        return { messageIndex: index + 1, isSafe: true };
      }
    }

    return {
      messageIndex: index,
      isSafe: false,
      reason: 'Pending tool calls without results',
    };
  }

  return { messageIndex: index, isSafe: false, reason: 'Unknown message role' };
}
```

### 8.2 Message Serialization for Resume

```typescript
// core/serialization.ts

export interface SerializedMessage {
  role: MessageRole;
  content: ContentBlock[];
  metadata?: MessageMetadata;
}

export function serializeForResume(
  messages: Message[],
  options: SerializationOptions
): SerializedMessage[] {
  return messages.map(msg => serializeMessage(msg, options));
}

function serializeMessage(
  msg: Message,
  options: SerializationOptions
): SerializedMessage {
  const serialized: SerializedMessage = {
    role: msg.role,
    content: [],
    metadata: msg.metadata,
  };

  for (const block of msg.content) {
    const serializedBlock = serializeBlock(block, options);
    if (serializedBlock) {
      serialized.content.push(serializedBlock);
    }
  }

  return serialized;
}

function serializeBlock(
  block: ContentBlock,
  options: SerializationOptions
): ContentBlock | null {
  // Handle reasoning blocks based on transport
  if (block.type === 'reasoning') {
    switch (options.reasoningTransport) {
      case 'provider':
        // Keep as-is for Anthropic/OpenAI
        return block;

      case 'text':
        // Convert to text block with <think> tags
        return {
          type: 'text',
          text: `<think>${block.reasoning}</think>`,
        };

      case 'omit':
        // Exclude from serialized output
        return null;
    }
  }

  return block;
}

export interface SerializationOptions {
  reasoningTransport: ReasoningTransport;

  // Whether to preserve thinking signatures
  preserveSignatures: boolean;

  // Max content length for truncation
  maxContentLength?: number;
}
```

### 8.3 Provider-Specific Resume Requirements

```typescript
// providers/resume-handlers.ts

export interface ResumeHandler {
  // Prepare messages for resuming conversation
  prepareForResume(messages: Message[]): Message[];

  // Validate messages are suitable for resume
  validateForResume(messages: Message[]): ValidationResult;
}

export const anthropicResumeHandler: ResumeHandler = {
  prepareForResume(messages) {
    // Anthropic requires thinking blocks with signatures for Claude 4+
    // Claude Opus 4.5 preserves thinking by default
    return messages.map(msg => {
      if (msg.role !== 'assistant') return msg;

      // Ensure reasoning blocks have signatures
      const validBlocks = msg.content.filter(block => {
        if (block.type === 'reasoning') {
          // Blocks without signatures can still be passed (they'll be ignored)
          return true;
        }
        return true;
      });

      return { ...msg, content: validBlocks };
    });
  },

  validateForResume(messages) {
    // Check for sequence integrity
    const errors: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Check tool_use has corresponding tool_result
      if (msg.role === 'assistant') {
        const toolUses = msg.content.filter(b => b.type === 'tool_use');
        if (toolUses.length > 0 && i < messages.length - 1) {
          const nextMsg = messages[i + 1];
          if (nextMsg.role !== 'user') {
            errors.push(`Tool use at index ${i} not followed by user message`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

export const deepseekResumeHandler: ResumeHandler = {
  prepareForResume(messages) {
    // DeepSeek: MUST NOT include reasoning_content in next turn
    // Only include content field
    return messages.map(msg => {
      if (msg.role !== 'assistant') return msg;

      // Filter out reasoning blocks
      const filteredBlocks = msg.content.filter(b => b.type !== 'reasoning');

      return { ...msg, content: filteredBlocks };
    });
  },

  validateForResume(messages) {
    // Check that reasoning is not included in history
    const errors: string[] = [];

    for (let i = 0; i < messages.length - 1; i++) {  // Skip last message
      const msg = messages[i];
      if (msg.role === 'assistant') {
        const hasReasoning = msg.content.some(b => b.type === 'reasoning');
        if (hasReasoning) {
          errors.push(
            `DeepSeek: reasoning_content must not be included at index ${i}`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

export const qwenResumeHandler: ResumeHandler = {
  prepareForResume(messages) {
    // Qwen: Similar to DeepSeek, reasoning_content should be omitted
    return messages.map(msg => {
      if (msg.role !== 'assistant') return msg;

      const filteredBlocks = msg.content.filter(b => b.type !== 'reasoning');

      return { ...msg, content: filteredBlocks };
    });
  },

  validateForResume(messages) {
    return { valid: true, errors: [] };
  },
};
```

---

## Part 9: Provider-Specific Implementations

### 9.1 Anthropic Provider

```typescript
// providers/anthropic.ts

export class AnthropicProvider implements ModelProvider<AnthropicProviderOptions> {
  readonly id = 'anthropic';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  private options: AnthropicProviderOptions;
  private client: AnthropicClient;

  constructor(
    apiKey: string,
    model: string,
    options: AnthropicProviderOptions = {}
  ) {
    this.model = model;
    this.options = {
      reasoningTransport: 'provider',
      ...options,
    };

    this.capabilities = {
      supportsThinking: true,
      supportsInterleavedThinking: true,
      supportsImages: true,
      supportsAudio: false,
      supportsFiles: true,
      supportsTools: true,
      supportsStreaming: true,
      supportsCache: true,
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
      minCacheableTokens: this.getMinCacheableTokens(),
      maxCacheBreakpoints: 4,
    };

    this.client = new AnthropicClient(apiKey, options.proxyUrl);
  }

  async complete(
    messages: Message[],
    options?: CompletionOptions
  ): Promise<ModelResponse> {
    const body = this.buildRequestBody(messages, options);

    const response = await withRetry(
      () => this.client.post('/v1/messages', body),
      DEFAULT_RETRY_CONFIG
    );

    return fromAnthropicResponse(response);
  }

  async *stream(
    messages: Message[],
    options?: CompletionOptions
  ): AsyncIterable<StreamChunk> {
    const body = {
      ...this.buildRequestBody(messages, options),
      stream: true,
    };

    const response = await this.client.postStream('/v1/messages', body);

    for await (const event of response) {
      yield normalizeAnthropicStreamEvent(event);
    }
  }

  private buildRequestBody(
    messages: Message[],
    options?: CompletionOptions
  ): AnthropicRequestBody {
    const body: AnthropicRequestBody = {
      model: this.model,
      messages: toAnthropicMessages(messages, this.options),
      max_tokens: options?.maxTokens ?? 4096,
    };

    // System prompt
    if (options?.system) {
      body.system = this.buildSystemPrompt(options.system);
    }

    // Thinking configuration
    if (this.options.thinking?.enabled) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: this.options.thinking.budgetTokens ?? 10000,
      };
    }

    // Tools
    if (options?.tools?.length) {
      body.tools = options.tools.map(toAnthropicTool);
    }

    return body;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
    };

    const betas: string[] = [];

    if (this.options.beta?.interleavedThinking) {
      betas.push('interleaved-thinking-2025-05-14');
    }

    if (this.options.beta?.filesApi) {
      betas.push('files-api-2025-04-14');
    }

    if (this.options.beta?.extendedCacheTtl) {
      betas.push('extended-cache-ttl-2025-04-11');
    }

    if (betas.length > 0) {
      headers['anthropic-beta'] = betas.join(',');
    }

    return headers;
  }

  private getMinCacheableTokens(): number {
    if (this.model.includes('opus')) return 4096;
    if (this.model.includes('haiku-4-5')) return 4096;
    if (this.model.includes('haiku')) return 2048;
    return 1024;  // Sonnet
  }
}
```

### 9.2 OpenAI Provider (Unified)

```typescript
// providers/openai.ts

export class OpenAIProvider implements ModelProvider<OpenAIProviderOptions> {
  readonly id = 'openai';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  private options: OpenAIProviderOptions;
  private client: OpenAIClient;

  constructor(
    apiKey: string,
    model: string,
    options: OpenAIProviderOptions
  ) {
    this.model = model;
    this.options = options;

    this.capabilities = this.deriveCapabilities();
    this.client = new OpenAIClient(apiKey, options.proxyUrl);
  }

  async complete(
    messages: Message[],
    options?: CompletionOptions
  ): Promise<ModelResponse> {
    if (this.options.api === 'responses') {
      return this.completeResponses(messages, options);
    }
    return this.completeChat(messages, options);
  }

  private async completeChat(
    messages: Message[],
    options?: CompletionOptions
  ): Promise<ModelResponse> {
    const body = {
      model: this.model,
      messages: toOpenAIChatMessages(messages),
      max_tokens: options?.maxTokens,
      ...(options?.tools && { tools: options.tools.map(toOpenAITool) }),
    };

    const response = await withRetry(
      () => this.client.post('/chat/completions', body)
    );

    return fromOpenAIChatResponse(response);
  }

  private async completeResponses(
    messages: Message[],
    options?: CompletionOptions
  ): Promise<ModelResponse> {
    const body: OpenAIResponsesBody = {
      model: this.model,
      input: toOpenAIResponsesInput(messages),
    };

    // Reasoning configuration
    if (this.options.responses?.reasoning) {
      body.reasoning = this.options.responses.reasoning;
    }

    // State persistence
    if (this.options.responses?.store) {
      body.store = true;
    }

    // Multi-turn continuation
    if (this.options.responses?.previousResponseId) {
      body.previous_response_id = this.options.responses.previousResponseId;
    }

    // Tools
    if (options?.tools?.length) {
      body.tools = options.tools.map(toOpenAIResponsesTool);
    }

    const response = await withRetry(
      () => this.client.post('/responses', body)
    );

    return fromOpenAIResponsesResponse(response);
  }

  private deriveCapabilities(): ProviderCapabilities {
    const isResponses = this.options.api === 'responses';

    return {
      supportsThinking: isResponses,
      supportsInterleavedThinking: false,
      supportsImages: true,
      supportsAudio: !isResponses,  // Audio not yet in Responses API
      supportsFiles: isResponses,
      supportsTools: true,
      supportsStreaming: true,
      supportsCache: true,
      maxContextTokens: 128000,
      maxOutputTokens: 16384,
      minCacheableTokens: 1024,
    };
  }
}
```

---

## Part 10: Factory and Registry

### 10.1 Provider Factory

```typescript
// providers/factory.ts

export interface ProviderConfig {
  provider: ProviderType;
  apiKey: string;
  model: string;
  baseUrl?: string;
  options?: Record<string, unknown>;
}

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'openai-responses'
  | 'gemini'
  | 'deepseek'
  | 'qwen'
  | 'glm'
  | 'kimi'
  | 'minimax'
  | 'openrouter'
  | 'groq'
  | 'cerebras';

export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(
        config.apiKey,
        config.model,
        config.options as AnthropicProviderOptions
      );

    case 'openai':
      return new OpenAIProvider(
        config.apiKey,
        config.model,
        { api: 'chat', ...config.options } as OpenAIProviderOptions
      );

    case 'openai-responses':
      return new OpenAIProvider(
        config.apiKey,
        config.model,
        { api: 'responses', ...config.options } as OpenAIProviderOptions
      );

    case 'gemini':
      return new GeminiProvider(
        config.apiKey,
        config.model,
        config.options as GeminiProviderOptions
      );

    case 'deepseek':
      return new DeepSeekProvider(
        config.apiKey,
        config.model,
        config.options as DeepSeekProviderOptions
      );

    case 'qwen':
      return new QwenProvider(
        config.apiKey,
        config.model,
        config.options as QwenProviderOptions
      );

    // ... other providers

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
```

### 10.2 Model Registry

```typescript
// providers/registry.ts

export interface ModelInfo {
  provider: ProviderType;
  modelId: string;
  displayName: string;

  // Capabilities
  capabilities: ProviderCapabilities;

  // Pricing (per 1M tokens)
  pricing: {
    input: number;
    output: number;
    cacheWrite?: number;
    cacheRead?: number;
    reasoning?: number;
  };

  // Context limits
  contextWindow: number;
  maxOutput: number;

  // Feature flags
  features: {
    thinking: boolean;
    vision: boolean;
    audio: boolean;
    files: boolean;
    cache: boolean;
  };
}

export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  'claude-opus-4-5': {
    provider: 'anthropic',
    modelId: 'claude-opus-4-5-20251101',
    displayName: 'Claude Opus 4.5',
    capabilities: {
      supportsThinking: true,
      supportsInterleavedThinking: true,
      supportsImages: true,
      supportsAudio: false,
      supportsFiles: true,
      supportsTools: true,
      supportsStreaming: true,
      supportsCache: true,
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
      minCacheableTokens: 4096,
      maxCacheBreakpoints: 4,
    },
    pricing: {
      input: 5.0,
      output: 25.0,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    },
    contextWindow: 200000,
    maxOutput: 8192,
    features: {
      thinking: true,
      vision: true,
      audio: false,
      files: true,
      cache: true,
    },
  },

  'gpt-5.2': {
    provider: 'openai-responses',
    modelId: 'gpt-5.2',
    displayName: 'GPT-5.2',
    capabilities: {
      supportsThinking: true,
      supportsInterleavedThinking: false,
      supportsImages: true,
      supportsAudio: false,
      supportsFiles: true,
      supportsTools: true,
      supportsStreaming: true,
      supportsCache: true,
      maxContextTokens: 128000,
      maxOutputTokens: 16384,
      minCacheableTokens: 1024,
    },
    pricing: {
      input: 5.0,
      output: 15.0,
    },
    contextWindow: 128000,
    maxOutput: 16384,
    features: {
      thinking: true,
      vision: true,
      audio: false,
      files: true,
      cache: true,
    },
  },

  'gemini-3-pro': {
    provider: 'gemini',
    modelId: 'gemini-3-pro',
    displayName: 'Gemini 3 Pro',
    capabilities: {
      supportsThinking: true,
      supportsInterleavedThinking: false,
      supportsImages: true,
      supportsAudio: true,
      supportsFiles: true,
      supportsTools: true,
      supportsStreaming: true,
      supportsCache: true,
      maxContextTokens: 1000000,
      maxOutputTokens: 8192,
      minCacheableTokens: 4096,
    },
    pricing: {
      input: 2.5,
      output: 10.0,
    },
    contextWindow: 1000000,
    maxOutput: 8192,
    features: {
      thinking: true,
      vision: true,
      audio: true,
      files: true,
      cache: true,
    },
  },

  'deepseek-reasoner': {
    provider: 'deepseek',
    modelId: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner (V3.2)',
    capabilities: {
      supportsThinking: true,
      supportsInterleavedThinking: false,
      supportsImages: false,
      supportsAudio: false,
      supportsFiles: false,
      supportsTools: true,
      supportsStreaming: true,
      supportsCache: true,
      maxContextTokens: 64000,
      maxOutputTokens: 64000,
    },
    pricing: {
      input: 0.28,
      output: 1.10,
      cacheRead: 0.028,
    },
    contextWindow: 64000,
    maxOutput: 64000,
    features: {
      thinking: true,
      vision: false,
      audio: false,
      files: false,
      cache: true,
    },
  },

  // ... more models
};

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return MODEL_REGISTRY[modelId];
}

export function getModelsForProvider(provider: ProviderType): ModelInfo[] {
  return Object.values(MODEL_REGISTRY).filter(m => m.provider === provider);
}
```

---

## Appendix A: Provider Compatibility Matrix

| Feature | Anthropic | OpenAI Chat | OpenAI Responses | Gemini 3 | DeepSeek | Qwen | GLM | Kimi | Minimax |
|---------|-----------|-------------|------------------|----------|----------|------|-----|------|---------|
| Thinking | Yes | No | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Interleaved Thinking | Yes | No | No | No | No | No | No | No | Yes |
| Thinking Signature | Yes | N/A | ID-based | Yes | N/A | N/A | N/A | N/A | N/A |
| Images | Yes | Yes | Yes | Yes | No | Yes | Yes | No | No |
| Audio | No | Yes | No | Yes | No | Yes | No | No | No |
| Files API | Yes | No | Yes | Yes | No | No | No | No | No |
| Prompt Cache | Explicit | Auto | Auto | Both | Auto | Explicit | No | Yes | No |
| Cache Breakpoints | 4 | N/A | N/A | 1 | N/A | 1 | N/A | 1 | N/A |
| Cache TTL | 5m/1h | 24h | 24h | Custom | Auto | Custom | N/A | N/A | N/A |
| Min Cache Tokens | 1024-4096 | 1024 | 1024 | 2048 | 64 | 2048 | N/A | N/A | N/A |
| Max Context | 200K | 128K | 128K | 1M | 64K | 32K | 200K | 256K | 32K |
| Tool Calling | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Parallel Tools | Yes | Yes | Yes | Yes | Yes | Yes | Yes | N/A | Yes |
| Streaming | SSE | SSE | Semantic | SSE | SSE | SSE | SSE | SSE | SSE |

## Appendix B: Multi-Turn Thinking Requirements

| Provider | Thinking in History | Signature Required | Notes |
|----------|---------------------|-------------------|-------|
| Anthropic | Yes (with signature) | Yes | Claude Opus 4.5 preserves by default |
| OpenAI Responses | Via ID | N/A | Use previous_response_id |
| Gemini | Optional | Yes (Flash) | thoughtSignature for function calls |
| DeepSeek | **NO** | N/A | Returns 400 if reasoning_content included |
| Qwen | No | N/A | Similar to DeepSeek |
| Minimax | Yes | N/A | Must preserve full response |

## Appendix C: Pricing Reference (per 1M tokens, USD)

| Provider | Model | Input | Output | Cache Write | Cache Read |
|----------|-------|-------|--------|-------------|------------|
| Anthropic | Opus 4.5 | $5.00 | $25.00 | $6.25 | $0.50 |
| Anthropic | Sonnet 4.5 | $3.00 | $15.00 | $3.75 | $0.30 |
| Anthropic | Haiku 4.5 | $1.00 | $5.00 | $1.25 | $0.10 |
| OpenAI | GPT-5.2 | $5.00 | $15.00 | Auto | 75% off |
| Gemini | 3 Pro | $2.50 | $10.00 | N/A | 75% off |
| Gemini | 3 Flash | $0.075 | $0.30 | N/A | 75% off |
| DeepSeek | Reasoner | $0.28 | $1.10 | N/A | $0.028 |
| Qwen | 3 Max | $0.80 | $2.00 | N/A | Varies |

---

## Summary

This architecture provides:

1. **Unified Type System**: Anthropic-style ContentBlocks as canonical format
2. **Provider-Specific Options**: No pseudo-abstractions, each provider has typed options
3. **Usage Statistics**: Normalized across all providers with cache metrics
4. **Error Hierarchy**: Typed errors with retry logic
5. **Logging/Audit**: Comprehensive logging with audit trail
6. **Resume/Fork Support**: Provider-aware message preparation
7. **Pure Transformations**: Testable conversion functions
8. **Registry Pattern**: Centralized model information

Key design decisions:
- DeepSeek/Qwen: Must NOT include reasoning_content in history (returns 400)
- Anthropic: Preserve thinking signatures for multi-turn
- OpenAI Responses: Use previous_response_id for state
- Gemini: Use thinkingLevel (not thinkingBudget) for 3.x models
- Cache strategies vary significantly by provider
