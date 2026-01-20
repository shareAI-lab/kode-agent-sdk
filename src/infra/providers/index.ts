/**
 * Provider Adapters Module
 *
 * KODE Agent SDK uses Anthropic-style messages as the internal canonical format.
 * Each provider is an adapter that converts to/from this internal format.
 *
 * Message Flow:
 * ```
 * Internal Message[] (Anthropic-style)
 *   -> Provider.formatMessages() -> External API format
 *   -> API call
 *   -> Response -> normalizeContent() -> Internal ContentBlock[]
 * ```
 *
 * Supported Providers:
 * - AnthropicProvider: Claude models with thinking blocks, files API
 * - OpenAIProvider: GPT models via Chat Completions or Responses API
 * - GeminiProvider: Gemini models with thinking support
 */

// Types
export type {
  ModelResponse,
  ModelStreamChunk,
  UploadFileInput,
  UploadFileResult,
  ThinkingOptions,
  ReasoningTransport,
  MultimodalOptions,
  ModelConfig,
  CompletionOptions,
  ModelProvider,
  ProviderCapabilities,
  CacheControl,
  AnthropicProviderOptions as AnthropicProviderOptionsType,
  OpenAIProviderOptions as OpenAIProviderOptionsType,
  GeminiProviderOptions as GeminiProviderOptionsType,
  DeepSeekProviderOptions,
  QwenProviderOptions,
  GLMProviderOptions,
  MinimaxProviderOptions,
} from './types';

// Provider implementations
export { AnthropicProvider, type AnthropicProviderOptions } from './anthropic';
export {
  OpenAIProvider,
  type OpenAIProviderOptions,
  type ReasoningConfig,
  type ResponsesApiConfig,
} from './openai';
export { GeminiProvider, type GeminiProviderOptions } from './gemini';

// Utilities (for custom provider implementations)
export {
  // Proxy
  resolveProxyUrl,
  getProxyDispatcher,
  withProxy,
  // URL normalization
  normalizeBaseUrl,
  normalizeOpenAIBaseUrl,
  normalizeAnthropicBaseUrl,
  normalizeGeminiBaseUrl,
  // Content blocks
  getMessageBlocks,
  markTransportIfDegraded,
  // Text formatting
  joinTextBlocks,
  formatToolResult,
  safeJsonStringify,
  // Unsupported content messages
  FILE_UNSUPPORTED_TEXT,
  IMAGE_UNSUPPORTED_TEXT,
  AUDIO_UNSUPPORTED_TEXT,
  // Reasoning/thinking
  concatTextWithReasoning,
  joinReasoningBlocks,
  normalizeThinkBlocks,
  splitThinkText,
  extractReasoningDetails,
  // Gemini helpers
  buildGeminiImagePart,
  buildGeminiFilePart,
  sanitizeGeminiSchema,
  // Anthropic helpers
  hasAnthropicFileBlocks,
  mergeAnthropicBetaHeader,
  normalizeAnthropicContent,
  normalizeAnthropicContentBlock,
  normalizeAnthropicDelta,
} from './utils';

// Core module (errors, usage, retry, logging, fork)
export * from './core';
