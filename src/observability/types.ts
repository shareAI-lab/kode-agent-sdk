import type { ObservationPersistenceConfig } from './persistence/types';
import type { OTelBridgeConfig } from './otel/types';

export type CaptureMode = 'off' | 'summary' | 'full' | 'redacted';

export type ObservationKind = 'agent_run' | 'generation' | 'tool' | 'subagent' | 'compression';
export type ObservationStatus = 'ok' | 'error' | 'cancelled';

export interface BaseObservation {
  kind: ObservationKind;
  agentId: string;
  runId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  status: ObservationStatus;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface GenerationObservation extends BaseObservation {
  kind: 'generation';
  provider?: string;
  model?: string;
  requestId?: string;
  inputSummary?: unknown;
  outputSummary?: unknown;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  cost?: {
    inputCost: number;
    outputCost: number;
    cacheWriteCost: number;
    totalCost: number;
    cacheSavings: number;
    currency: 'USD';
  };
  request?: {
    latencyMs: number;
    timeToFirstTokenMs?: number;
    tokensPerSecond?: number;
    stopReason?: string;
    retryCount?: number;
  };
  errorMessage?: string;
}

export interface ToolObservation extends BaseObservation {
  kind: 'tool';
  toolCallId: string;
  toolName: string;
  toolState: string;
  approvalRequired: boolean;
  approval?: {
    required: boolean;
    status: 'not_required' | 'pending' | 'approved' | 'denied';
    approvalId?: string;
    requestedAt?: number;
    decidedAt?: number;
    waitMs?: number;
    noteSummary?: string;
  };
  inputSummary?: unknown;
  outputSummary?: unknown;
  errorMessage?: string;
}

export interface SubagentObservation extends BaseObservation {
  kind: 'subagent';
  childAgentId: string;
  childRunId?: string;
  templateId: string;
  delegatedBy?: string;
  errorMessage?: string;
}

export interface CompressionObservation extends BaseObservation {
  kind: 'compression';
  policy: 'context_window';
  reason: 'token_threshold' | 'manual' | 'resume_recovery';
  messageCountBefore: number;
  messageCountAfter?: number;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  ratio?: number;
  summaryGenerated: boolean;
  errorMessage?: string;
}

export interface AgentRunObservation extends BaseObservation {
  kind: 'agent_run';
  trigger: 'send' | 'complete' | 'resume' | 'scheduler' | 'delegate';
  step: number;
  messageCountBefore: number;
  messageCountAfter?: number;
  errorMessage?: string;
}

export type ObservationRecord =
  | AgentRunObservation
  | GenerationObservation
  | ToolObservation
  | SubagentObservation
  | CompressionObservation;

export interface ObservationEnvelope<T extends ObservationRecord = ObservationRecord> {
  seq: number;
  timestamp: number;
  observation: T;
}

export interface ObservationQueryOptions {
  agentId?: string;
  kinds?: ObservationKind[];
  runId?: string;
  traceId?: string;
  parentSpanId?: string;
  statuses?: ObservationStatus[];
  sinceSeq?: number;
}

export interface ObservationListOptions extends ObservationQueryOptions {
  limit?: number;
}

export interface ObservationRunView {
  run: ObservationEnvelope<AgentRunObservation>;
  observations: ObservationEnvelope[];
}

export interface AgentMetricsSnapshot {
  agentId: string;
  currentRunId?: string;
  traceId?: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens: number;
    totalCostUsd: number;
    toolCalls: number;
    toolErrors: number;
    approvalRequests: number;
    approvalDenials: number;
    approvalWaitMsTotal: number;
    compressions: number;
    compressionErrors: number;
    tokensSavedEstimate: number;
    scheduledRuns: number;
    generations: number;
    generationErrors: number;
    subagents: number;
  };
  lastGeneration?: {
    provider?: string;
    model?: string;
    requestId?: string;
    latencyMs?: number;
    timeToFirstTokenMs?: number;
    stopReason?: string;
    retryCount?: number;
    totalTokens?: number;
    totalCostUsd?: number;
  };
}

export interface ObservationSubscribeOptions extends ObservationQueryOptions {}

export interface ObservationSink {
  onObservation(envelope: ObservationEnvelope): void | Promise<void>;
}

export interface ObservationReader {
  subscribe(opts?: ObservationSubscribeOptions): AsyncIterable<ObservationEnvelope>;
  getMetricsSnapshot(): AgentMetricsSnapshot;
  listObservations(opts?: ObservationListOptions): ObservationEnvelope[];
  getRun(runId: string): ObservationRunView | undefined;
}

export interface ObservabilityConfig {
  enabled?: boolean;
  sink?: ObservationSink;
  otel?: OTelBridgeConfig;
  persistence?: ObservationPersistenceConfig;
  capture?: {
    generationInput?: CaptureMode;
    generationOutput?: CaptureMode;
    toolInput?: CaptureMode;
    toolOutput?: CaptureMode;
  };
}
