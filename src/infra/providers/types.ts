/**
 * Provider Adapter Types
 *
 * KODE Agent SDK uses Anthropic-style messages as the internal canonical format.
 * All providers act as adapters that convert to/from this format.
 *
 * Internal Flow:
 *   Internal Message[] (Anthropic-style ContentBlocks)
 *     -> Provider.formatMessages() -> External API format
 *     -> API call
 *     -> Response -> normalizeContent() -> Internal ContentBlock[]
 *
 * Provider-Specific Requirements:
 * - Anthropic: Preserve thinking signatures for multi-turn
 * - OpenAI Responses: Use previous_response_id for state
 * - DeepSeek/Qwen: Must NOT include reasoning_content in history
 * - Gemini: Use thinkingLevel (not thinkingBudget) for 3.x
 */

import { Message, ContentBlock } from '../../core/types';
import { Configurable } from '../../core/config';
import { UsageStatistics } from './core/usage';

/**
 * Standard model response in Anthropic-style format.
 * All providers convert their responses to this format.
 */
export interface ModelResponse {
  role: 'assistant';
  content: ContentBlock[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    // Optional extended usage stats
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  stop_reason?: string;
  // Optional extended statistics
  extendedUsage?: UsageStatistics;
}

/**
 * Streaming chunk in Anthropic-style format.
 * All providers emit chunks in this format.
 */
export interface ModelStreamChunk {
  type: 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  index?: number;
  content_block?: ContentBlock;
  delta?: {
    type: 'text_delta' | 'input_json_delta' | 'reasoning_delta';
    text?: string;
    partial_json?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens: number;
  };
}

/**
 * File upload input.
 */
export interface UploadFileInput {
  data: Buffer;
  mimeType: string;
  filename?: string;
  kind: 'image' | 'audio' | 'video' | 'file';
}

/**
 * File upload result.
 */
export interface UploadFileResult {
  fileId?: string;
  fileUri?: string;
}

/**
 * Thinking/reasoning configuration options.
 * Each provider interprets these options according to their API:
 *
 * - Anthropic: thinking.budget_tokens, interleaved-thinking-2025-05-14 beta
 * - OpenAI: reasoning_effort for Responses API (none/minimal/low/medium/high/xhigh)
 * - Gemini: thinkingBudget (2.5 models) or thinkingLevel (3.x models)
 */
export interface ThinkingOptions {
  /** Enable thinking/reasoning mode */
  enabled?: boolean;
  /** Budget tokens for reasoning (Anthropic: budget_tokens, Gemini: thinkingBudget) */
  budgetTokens?: number;
  /** Reasoning effort level (OpenAI: reasoning_effort) */
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Thinking level preset (Gemini 3.x: thinkingLevel) */
  level?: 'minimal' | 'low' | 'medium' | 'high';
}

/**
 * How reasoning/thinking content is transported in messages.
 * - 'provider': Native provider format (Anthropic thinking blocks, OpenAI reasoning tokens)
 * - 'text': Wrapped in <think></think> tags as text
 * - 'omit': Excluded from message history
 */
export type ReasoningTransport = 'omit' | 'text' | 'provider';

/**
 * Multimodal content handling options.
 */
export interface MultimodalOptions {
  /** URL handling mode */
  mode?: 'url' | 'url+base64';
  /** Maximum size for base64 encoded content */
  maxBase64Bytes?: number;
  /** Allowed MIME types */
  allowMimeTypes?: string[];

  /** Audio-specific options */
  audio?: {
    /** Allowed audio MIME types */
    allowMimeTypes?: string[];
    /** Maximum audio duration in seconds */
    maxDurationSec?: number;
    /** Custom transcriber callback for providers without native audio support */
    customTranscriber?: (audio: {
      base64?: string;
      url?: string;
      mimeType?: string;
    }) => Promise<string>;
  };

  /** Video-specific options */
  video?: {
    /** Allowed video MIME types */
    allowMimeTypes?: string[];
    /** Maximum video duration in seconds */
    maxDurationSec?: number;
    /** Custom frame extractor callback for providers without native video support */
    customFrameExtractor?: (video: {
      base64?: string;
      url?: string;
      mimeType?: string;
    }) => Promise<Array<{ base64: string; mimeType: string }>>;
  };
}

/**
 * Core model configuration.
 * Provider implementations extend this with provider-specific options.
 */
export interface ModelConfig {
  provider: 'anthropic' | 'openai' | 'gemini' | string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  proxyUrl?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: MultimodalOptions;
  thinking?: ThinkingOptions;
}

/**
 * Options for model completion requests.
 */
export interface CompletionOptions {
  tools?: any[];
  maxTokens?: number;
  temperature?: number;
  system?: string;
  stream?: boolean;
  thinking?: ThinkingOptions;
}

/**
 * Core model provider interface.
 * All provider implementations must conform to this interface.
 *
 * The adapter pattern:
 * 1. Input: SDK internal Message[] (Anthropic-style ContentBlocks)
 * 2. Provider converts to external API format
 * 3. Provider calls external API
 * 4. Provider converts response back to internal format
 * 5. Output: ModelResponse with Anthropic-style ContentBlocks
 */
export interface ModelProvider extends Configurable<ModelConfig> {
  /** Model identifier */
  readonly model: string;
  /** Maximum context window size in tokens */
  readonly maxWindowSize: number;
  /** Maximum output tokens */
  readonly maxOutputTokens: number;
  /** Default temperature */
  readonly temperature: number;

  /**
   * Complete a message sequence.
   * @param messages - Messages in internal Anthropic-style format
   * @param opts - Completion options
   * @returns Response in internal format
   */
  complete(messages: Message[], opts?: CompletionOptions): Promise<ModelResponse>;

  /**
   * Stream a completion.
   * @param messages - Messages in internal Anthropic-style format
   * @param opts - Completion options
   * @returns Async iterable of chunks in internal format
   */
  stream(messages: Message[], opts?: CompletionOptions): AsyncIterable<ModelStreamChunk>;

  /**
   * Upload a file to the provider (optional).
   * @param input - File upload input
   * @returns Upload result or null if not supported
   */
  uploadFile?(input: UploadFileInput): Promise<UploadFileResult | null>;
}

/**
 * Provider capabilities declaration.
 * Used to check feature support before making requests.
 */
export interface ProviderCapabilities {
  // Feature support
  supportsThinking: boolean;
  supportsInterleavedThinking: boolean;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsAudioOutput: boolean;
  supportsFiles: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsCache: boolean;

  // Limits
  maxContextTokens: number;
  maxOutputTokens: number;
  maxAudioDurationSec?: number;
  maxVideoDurationSec?: number;
  maxInlineDataBytes?: number;

  // Cache requirements
  minCacheableTokens?: number;
  maxCacheBreakpoints?: number;
}

/**
 * Cache control options.
 */
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';  // Anthropic extended TTL
}

/**
 * Provider-specific Anthropic options.
 */
export interface AnthropicProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: MultimodalOptions;

  // Extended thinking configuration
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

/**
 * Provider-specific OpenAI options.
 * For detailed configuration, see openai.ts ReasoningConfig and ResponsesApiConfig.
 */
export interface OpenAIProviderOptions {
  /** API type: 'chat' for Chat Completions, 'responses' for Responses API */
  api?: 'chat' | 'responses';
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: MultimodalOptions;

  /**
   * Reasoning configuration for OpenAI-compatible providers.
   * Configure field names and request parameters for DeepSeek, GLM, Minimax, Qwen, etc.
   */
  reasoning?: {
    /** Field name: 'reasoning_content' (DeepSeek/GLM/Qwen) or 'reasoning_details' (Minimax) */
    fieldName?: 'reasoning_content' | 'reasoning_details';
    /** Request parameters to enable reasoning (e.g., { thinking: { type: 'enabled' } }) */
    requestParams?: Record<string, any>;
    /** Strip reasoning from history (required for DeepSeek) */
    stripFromHistory?: boolean;
  };

  /** Responses API specific options */
  responses?: {
    reasoning?: {
      effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    };
    store?: boolean;
    previousResponseId?: string;
  };

  /** Streaming options */
  streamOptions?: {
    includeUsage?: boolean;
  };
}

/**
 * Provider-specific Gemini options.
 */
export interface GeminiProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: MultimodalOptions;

  // Gemini 3.x thinking config
  thinking?: {
    level: 'minimal' | 'low' | 'medium' | 'high';
    includeThoughts?: boolean;
  };

  // Context caching
  cache?: {
    cachedContentName?: string;
    createCache?: {
      displayName: string;
      ttlSeconds: number;
    };
  };

  // Media resolution for multimodal
  mediaResolution?: 'low' | 'medium' | 'high';
}

/**
 * Provider-specific DeepSeek options.
 */
export interface DeepSeekProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;

  thinking?: {
    enabled: boolean;
  };

  // DeepSeek uses automatic prefix caching - no explicit config needed
}

/**
 * Provider-specific Qwen options.
 */
export interface QwenProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;

  thinking?: {
    enabled: boolean;
    budget?: number;  // thinking_budget parameter
  };

  // Region selection
  region?: 'beijing' | 'singapore' | 'virginia';
}

/**
 * Provider-specific GLM options.
 */
export interface GLMProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;

  thinking?: {
    enabled: boolean;
  };

  // Max 128 functions
  maxFunctions?: number;
}

/**
 * Provider-specific Minimax options.
 */
export interface MinimaxProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;

  // reasoning_split parameter
  reasoningSplit?: boolean;
}
