/**
 * Core Provider Module
 *
 * Re-exports all core utilities for provider implementations.
 */

// Error types and utilities
export {
  ProviderError,
  ProviderErrorCode,
  ProviderErrorDetails,
  RateLimitError,
  AuthenticationError,
  ContextLengthError,
  InvalidRequestError,
  ServerError,
  TimeoutError,
  NetworkError,
  ContentFilterError,
  ModelNotFoundError,
  QuotaExceededError,
  ServiceUnavailableError,
  ThinkingSignatureError,
  StreamError,
  ParseError,
  parseProviderError,
  isRetryableError,
  isRateLimitError,
  isAuthError,
  isContextLengthError,
  isContentFilterError,
} from './errors';

// Usage statistics and cost calculation
export {
  UsageStatistics,
  CacheMetrics,
  CostBreakdown,
  RequestMetrics,
  ModelPricing,
  PROVIDER_PRICING,
  createEmptyUsage,
  calculateCost,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeGeminiUsage,
  normalizeDeepSeekUsage,
  aggregateUsage,
  formatUsageString,
} from './usage';

// Retry strategy
export {
  RetryConfig,
  DEFAULT_RETRY_CONFIG,
  AGGRESSIVE_RETRY_CONFIG,
  OnRetryCallback,
  withRetry,
  withRetryAndTimeout,
  createRetryWrapper,
  shouldRetry,
  getRetryDelay,
} from './retry';

// Logging and debugging
export {
  LogLevel,
  LogEntry,
  Logger,
  ProviderLogger,
  ProviderRequest,
  ProviderResponse,
  DebugConfig,
  DEFAULT_DEBUG_CONFIG,
  AuditRecord,
  AuditFilter,
  AuditAggregation,
  AuditStore,
  createConsoleLogger,
  createProviderLogger,
  redactSensitive,
  truncateContent,
  generateAuditId,
} from './logger';

// Fork point detection and resume
export {
  ForkPoint,
  ValidationResult,
  ResumeHandler,
  SerializationOptions,
  findSafeForkPoints,
  getLastSafeForkPoint,
  serializeForResume,
  anthropicResumeHandler,
  deepseekResumeHandler,
  qwenResumeHandler,
  openaiChatResumeHandler,
  openaiResponsesResumeHandler,
  geminiResumeHandler,
  getResumeHandler,
  prepareMessagesForResume,
  validateMessagesForResume,
  canForkAt,
  forkAt,
} from './fork';
