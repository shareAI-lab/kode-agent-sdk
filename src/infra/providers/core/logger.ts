/**
 * Logging and Debugging Module
 *
 * Unified logging interfaces for provider operations,
 * request/response tracking, and audit trail.
 */

import { UsageStatistics } from './usage';
import { ProviderErrorDetails } from './errors';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log entry structure.
 */
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

/**
 * Core logger interface.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;

  // Create child logger with additional context
  child(context: Record<string, unknown>): Logger;
}

/**
 * Provider-specific logger with request/response tracking.
 */
export interface ProviderLogger extends Logger {
  // Log request/response pairs
  logRequest(request: ProviderRequest): void;
  logResponse(response: ProviderResponse, durationMs: number): void;
  logError(error: ProviderErrorDetails): void;

  // Log streaming events
  logStreamStart(requestId: string): void;
  logStreamChunk(requestId: string, chunkSize: number): void;
  logStreamEnd(requestId: string, totalChunks: number): void;

  // Log cache operations
  logCacheHit(tokens: number): void;
  logCacheWrite(tokens: number, ttl: string): void;

  // Log retry attempts
  logRetry(attempt: number, delayMs: number, error: ProviderErrorDetails): void;
}

/**
 * Provider request details for logging.
 */
export interface ProviderRequest {
  provider: string;
  model: string;
  requestId?: string;
  timestamp: number;

  // Message counts
  messageCount: number;
  estimatedTokens?: number;

  // Options
  maxTokens?: number;
  temperature?: number;
  toolCount?: number;
  streaming: boolean;

  // Cache settings
  cacheEnabled?: boolean;
  cacheBreakpoints?: number;
}

/**
 * Provider response details for logging.
 */
export interface ProviderResponse {
  provider: string;
  model: string;
  requestId?: string;
  timestamp: number;

  // Token usage
  usage: UsageStatistics;

  // Response info
  stopReason?: string;
  contentBlockCount: number;
  hasToolUse: boolean;

  // Timing
  durationMs: number;
  timeToFirstTokenMs?: number;
}

/**
 * Debug configuration options.
 */
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

/**
 * Default debug configuration.
 */
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

/**
 * Audit record for compliance and debugging.
 */
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

  // Error info (if failed)
  error?: ProviderErrorDetails;

  // Timing
  latencyMs: number;
  timeToFirstTokenMs?: number;

  // Agent context
  agentId?: string;
  sessionId?: string;
  stepNumber?: number;
}

/**
 * Audit filter for querying records.
 */
export interface AuditFilter {
  provider?: string;
  model?: string;
  agentId?: string;
  sessionId?: string;

  // Time range
  startTime?: number;
  endTime?: number;

  // Error filtering
  hasError?: boolean;
  errorCode?: string;

  // Pagination
  limit?: number;
  offset?: number;
}

/**
 * Audit aggregation results.
 */
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
    errorRate: number;
  }>;

  byModel: Map<string, {
    requests: number;
    tokens: number;
    cost: number;
    errorRate: number;
  }>;

  // Time series (hourly)
  hourly?: Array<{
    hour: number;
    requests: number;
    tokens: number;
    cost: number;
  }>;
}

/**
 * Audit store interface.
 */
export interface AuditStore {
  record(audit: AuditRecord): Promise<void>;
  query(filter: AuditFilter): Promise<AuditRecord[]>;
  aggregate(filter: AuditFilter): Promise<AuditAggregation>;
}

/**
 * Create a console-based logger.
 */
export function createConsoleLogger(
  context: Record<string, unknown> = {},
  debugConfig: Partial<DebugConfig> = {}
): Logger {
  const config = { ...DEFAULT_DEBUG_CONFIG, ...debugConfig };

  const log = (level: LogLevel, message: string, ctx?: Record<string, unknown>) => {
    if (!config.verbose && level === 'debug') return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: Date.now(),
      context: { ...context, ...ctx },
    };

    const prefix = `[${level.toUpperCase()}]`;
    const contextStr = Object.keys(entry.context || {}).length > 0
      ? ` ${JSON.stringify(entry.context)}`
      : '';

    const output = `${prefix} ${message}${contextStr}`;

    switch (level) {
      case 'debug':
        console.debug(output);
        break;
      case 'info':
        console.info(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  };

  return {
    debug: (message, ctx) => log('debug', message, ctx),
    info: (message, ctx) => log('info', message, ctx),
    warn: (message, ctx) => log('warn', message, ctx),
    error: (message, ctx) => log('error', message, ctx),
    child: (childContext) => createConsoleLogger({ ...context, ...childContext }, debugConfig),
  };
}

/**
 * Create a provider logger with request/response tracking.
 */
export function createProviderLogger(
  provider: string,
  debugConfig: Partial<DebugConfig> = {}
): ProviderLogger {
  const config = { ...DEFAULT_DEBUG_CONFIG, ...debugConfig };
  const base = createConsoleLogger({ provider }, debugConfig);

  return {
    ...base,

    logRequest(request: ProviderRequest) {
      if (!config.verbose) return;

      base.info('Provider request', {
        model: request.model,
        requestId: request.requestId,
        messageCount: request.messageCount,
        estimatedTokens: request.estimatedTokens,
        streaming: request.streaming,
        toolCount: request.toolCount,
      });
    },

    logResponse(response: ProviderResponse, durationMs: number) {
      if (config.logTokenUsage) {
        base.info('Provider response', {
          model: response.model,
          requestId: response.requestId,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          durationMs,
          stopReason: response.stopReason,
        });
      }
    },

    logError(error: ProviderErrorDetails) {
      base.error('Provider error', {
        code: error.code,
        requestId: error.requestId,
        retryable: error.retryable,
      });
    },

    logStreamStart(requestId: string) {
      if (config.verbose) {
        base.debug('Stream started', { requestId });
      }
    },

    logStreamChunk(requestId: string, chunkSize: number) {
      if (config.verbose) {
        base.debug('Stream chunk', { requestId, chunkSize });
      }
    },

    logStreamEnd(requestId: string, totalChunks: number) {
      if (config.verbose) {
        base.debug('Stream ended', { requestId, totalChunks });
      }
    },

    logCacheHit(tokens: number) {
      if (config.logCache) {
        base.info('Cache hit', { tokens });
      }
    },

    logCacheWrite(tokens: number, ttl: string) {
      if (config.logCache) {
        base.info('Cache write', { tokens, ttl });
      }
    },

    logRetry(attempt: number, delayMs: number, error: ProviderErrorDetails) {
      if (config.logRetries) {
        base.warn('Retrying request', {
          attempt,
          delayMs,
          errorCode: error.code,
        });
      }
    },

    child(childContext: Record<string, unknown>) {
      return createProviderLogger(provider, debugConfig) as any;
    },
  };
}

/**
 * Redact sensitive data from an object.
 */
export function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = [
    'apiKey',
    'api_key',
    'authorization',
    'Authorization',
    'token',
    'secret',
    'password',
    'credential',
  ];

  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.some(k => key.toLowerCase().includes(k.toLowerCase()))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Truncate content for logging.
 */
export function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + `... [truncated, ${content.length - maxLength} more chars]`;
}

/**
 * Generate unique audit ID.
 */
export function generateAuditId(): string {
  return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
