/**
 * Provider Module
 *
 * Re-exports from the providers module for backward compatibility.
 * The actual implementations are in src/infra/providers/.
 *
 * Usage:
 * ```typescript
 * import { AnthropicProvider, OpenAIProvider, GeminiProvider } from './infra/provider';
 * // or
 * import { AnthropicProvider } from './infra/providers';
 * ```
 */

// Re-export all types
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
  DeepSeekProviderOptions,
  QwenProviderOptions,
  GLMProviderOptions,
  MinimaxProviderOptions,
} from './providers';

// Re-export provider implementations
export { AnthropicProvider, OpenAIProvider, GeminiProvider } from './providers';

// Re-export utilities for backward compatibility
export {
  resolveProxyUrl,
  getProxyDispatcher,
  withProxy,
  normalizeBaseUrl,
  normalizeOpenAIBaseUrl,
  normalizeAnthropicBaseUrl,
  normalizeGeminiBaseUrl,
  getMessageBlocks,
  markTransportIfDegraded,
  joinTextBlocks,
  formatToolResult,
  safeJsonStringify,
  FILE_UNSUPPORTED_TEXT,
  IMAGE_UNSUPPORTED_TEXT,
  AUDIO_UNSUPPORTED_TEXT,
  concatTextWithReasoning,
  joinReasoningBlocks,
  normalizeThinkBlocks,
  splitThinkText,
  extractReasoningDetails,
  buildGeminiImagePart,
  buildGeminiFilePart,
  sanitizeGeminiSchema,
  hasAnthropicFileBlocks,
  mergeAnthropicBetaHeader,
  normalizeAnthropicContent,
  normalizeAnthropicContentBlock,
  normalizeAnthropicDelta,
} from './providers';

// Re-export core module (errors, usage, retry, logging, fork)
export * from './providers/core';
