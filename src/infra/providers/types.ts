// Provider adapter pattern types
// Internal format follows Anthropic-style messages as canonical representation

import { ContentBlock, Message } from '../../core/types';
import { Configurable } from '../../core/config';

/**
 * Standard model response in Anthropic-style format
 * All providers convert their responses to this format
 */
export interface ModelResponse {
  role: 'assistant';
  content: ContentBlock[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  stop_reason?: string;
}

/**
 * Streaming chunk in Anthropic-style format
 * All providers emit chunks in this format
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
 * File upload input
 */
export interface UploadFileInput {
  data: Buffer;
  mimeType: string;
  filename?: string;
  kind: 'image' | 'file';
}

/**
 * File upload result
 */
export interface UploadFileResult {
  fileId?: string;
  fileUri?: string;
}

/**
 * Thinking/reasoning configuration options
 * Each provider interprets these options according to their API
 */
export interface ThinkingOptions {
  /** Enable thinking/reasoning mode */
  enabled?: boolean;
  /** Budget tokens for reasoning (Anthropic: budget_tokens, Gemini: thinkingBudget) */
  budgetTokens?: number;
  /** Reasoning effort level (OpenAI: reasoning_effort) */
  effort?: 'low' | 'medium' | 'high';
  /** Thinking level preset (Gemini 3.x: thinkingLevel) */
  level?: 'none' | 'low' | 'medium' | 'high';
}

/**
 * How reasoning/thinking content is transported in messages
 * - 'provider': Native provider format (Anthropic thinking blocks, OpenAI reasoning tokens)
 * - 'text': Wrapped in <think></think> tags as text
 * - 'omit': Excluded from message history
 */
export type ReasoningTransport = 'omit' | 'text' | 'provider';

/**
 * Multimodal content handling options
 */
export interface MultimodalOptions {
  /** URL handling mode */
  mode?: 'url' | 'url+base64';
  /** Maximum size for base64 encoded content */
  maxBase64Bytes?: number;
  /** Allowed MIME types */
  allowMimeTypes?: string[];
}

/**
 * Core model configuration
 * Provider implementations extend this with provider-specific options
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
 * Options for model completion requests
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
 * Core model provider interface
 * All provider implementations must conform to this interface
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
   * Complete a message sequence
   * @param messages - Messages in internal Anthropic-style format
   * @param opts - Completion options
   * @returns Response in internal format
   */
  complete(messages: Message[], opts?: CompletionOptions): Promise<ModelResponse>;

  /**
   * Stream a completion
   * @param messages - Messages in internal Anthropic-style format
   * @param opts - Completion options
   * @returns Async iterable of chunks in internal format
   */
  stream(messages: Message[], opts?: CompletionOptions): AsyncIterable<ModelStreamChunk>;

  /**
   * Upload a file to the provider (optional)
   * @param input - File upload input
   * @returns Upload result or null if not supported
   */
  uploadFile?(input: UploadFileInput): Promise<UploadFileResult | null>;
}

/**
 * Provider-specific Anthropic options
 */
export interface AnthropicProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: MultimodalOptions;
}

/**
 * Provider-specific OpenAI options
 */
export interface OpenAIProviderOptions {
  providerName?: string;
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: MultimodalOptions;
}

/**
 * Provider-specific Gemini options
 */
export interface GeminiProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: MultimodalOptions;
}
