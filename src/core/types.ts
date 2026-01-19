// Core type definitions for KODE SDK v2.7

export type MessageRole = 'user' | 'assistant' | 'system';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: any; is_error?: boolean };

export interface Message {
  role: MessageRole;
  content: ContentBlock[];
}

export interface Bookmark {
  seq: number;
  timestamp: number;
}

export type AgentChannel = 'progress' | 'control' | 'monitor';

export type AgentRuntimeState = 'READY' | 'WORKING' | 'PAUSED';

export type BreakpointState =
  | 'READY'
  | 'PRE_MODEL'
  | 'STREAMING_MODEL'
  | 'TOOL_PENDING'
  | 'AWAITING_APPROVAL'
  | 'PRE_TOOL'
  | 'TOOL_EXECUTING'
  | 'POST_TOOL';

export type ToolCallState =
  | 'PENDING'
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'DENIED'
  | 'SEALED';

export interface ToolCallApproval {
  required: boolean;
  decision?: 'allow' | 'deny';
  decidedBy?: string;
  decidedAt?: number;
  note?: string;
  meta?: Record<string, any>;
}

export interface ToolCallAuditEntry {
  state: ToolCallState;
  timestamp: number;
  note?: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: any;
  state: ToolCallState;
  approval: ToolCallApproval;
  result?: any;
  error?: string;
  isError?: boolean;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  createdAt: number;
  updatedAt: number;
  auditTrail: ToolCallAuditEntry[];
}

export type ToolCallSnapshot = Pick<
  ToolCallRecord,
  'id' | 'name' | 'state' | 'approval' | 'result' | 'error' | 'isError' | 'durationMs' | 'startedAt' | 'completedAt'
> & {
  inputPreview?: any;
  auditTrail?: ToolCallAuditEntry[];
};

export interface ProgressThinkChunkStartEvent {
  channel: 'progress';
  type: 'think_chunk_start';
  step: number;
  bookmark?: Bookmark;
}

export interface ProgressThinkChunkEvent {
  channel: 'progress';
  type: 'think_chunk';
  step: number;
  delta: string;
  bookmark?: Bookmark;
}

export interface ProgressThinkChunkEndEvent {
  channel: 'progress';
  type: 'think_chunk_end';
  step: number;
  bookmark?: Bookmark;
}

export interface ProgressTextChunkStartEvent {
  channel: 'progress';
  type: 'text_chunk_start';
  step: number;
  bookmark?: Bookmark;
}

export interface ProgressTextChunkEvent {
  channel: 'progress';
  type: 'text_chunk';
  step: number;
  delta: string;
  bookmark?: Bookmark;
}

export interface ProgressTextChunkEndEvent {
  channel: 'progress';
  type: 'text_chunk_end';
  step: number;
  text: string;
  bookmark?: Bookmark;
}

export interface ProgressToolStartEvent {
  channel: 'progress';
  type: 'tool:start';
  call: ToolCallSnapshot;
  bookmark?: Bookmark;
}

export interface ProgressToolEndEvent {
  channel: 'progress';
  type: 'tool:end';
  call: ToolCallSnapshot;
  bookmark?: Bookmark;
}

export interface ProgressToolErrorEvent {
  channel: 'progress';
  type: 'tool:error';
  call: ToolCallSnapshot;
  error: string;
  bookmark?: Bookmark;
}

export interface ProgressDoneEvent {
  channel: 'progress';
  type: 'done';
  step: number;
  reason: 'completed' | 'interrupted';
  bookmark?: Bookmark;
}

export type ProgressEvent =
  | ProgressThinkChunkStartEvent
  | ProgressThinkChunkEvent
  | ProgressThinkChunkEndEvent
  | ProgressTextChunkStartEvent
  | ProgressTextChunkEvent
  | ProgressTextChunkEndEvent
  | ProgressToolStartEvent
  | ProgressToolEndEvent
  | ProgressToolErrorEvent
  | ProgressDoneEvent;

export interface ControlPermissionRequiredEvent {
  channel: 'control';
  type: 'permission_required';
  call: ToolCallSnapshot;
  respond(decision: 'allow' | 'deny', opts?: { note?: string }): Promise<void>;
  bookmark?: Bookmark;
}

export interface ControlPermissionDecidedEvent {
  channel: 'control';
  type: 'permission_decided';
  callId: string;
  decision: 'allow' | 'deny';
  decidedBy: string;
  note?: string;
  bookmark?: Bookmark;
}

export type ControlEvent = ControlPermissionRequiredEvent | ControlPermissionDecidedEvent;

export interface MonitorStateChangedEvent {
  channel: 'monitor';
  type: 'state_changed';
  state: AgentRuntimeState;
  bookmark?: Bookmark;
}

export interface MonitorStepCompleteEvent {
  channel: 'monitor';
  type: 'step_complete';
  step: number;
  durationMs?: number;
  bookmark: Bookmark;
}

export interface MonitorErrorEvent {
  channel: 'monitor';
  type: 'error';
  severity: 'info' | 'warn' | 'error';
  phase: 'model' | 'tool' | 'system' | 'lifecycle';
  message: string;
  detail?: any;
  bookmark?: Bookmark;
}

export interface MonitorTokenUsageEvent {
  channel: 'monitor';
  type: 'token_usage';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  bookmark?: Bookmark;
}

export interface MonitorToolExecutedEvent {
  channel: 'monitor';
  type: 'tool_executed';
  call: ToolCallSnapshot;
  bookmark?: Bookmark;
}

export interface MonitorAgentResumedEvent {
  channel: 'monitor';
  type: 'agent_resumed';
  strategy: 'crash' | 'manual';
  sealed: ToolCallSnapshot[];
  bookmark?: Bookmark;
}

export interface MonitorBreakpointChangedEvent {
  channel: 'monitor';
  type: 'breakpoint_changed';
  previous: BreakpointState;
  current: BreakpointState;
  timestamp: number;
  bookmark?: Bookmark;
}

export interface MonitorTodoChangedEvent {
  channel: 'monitor';
  type: 'todo_changed';
  current: import('./todo').TodoItem[];
  previous: import('./todo').TodoItem[];
  bookmark?: Bookmark;
}

export interface MonitorTodoReminderEvent {
  channel: 'monitor';
  type: 'todo_reminder';
  todos: import('./todo').TodoItem[];
  reason: string;
  bookmark?: Bookmark;
}

export interface MonitorFileChangedEvent {
  channel: 'monitor';
  type: 'file_changed';
  path: string;
  mtime: number;
  bookmark?: Bookmark;
}

export interface MonitorReminderSentEvent {
  channel: 'monitor';
  type: 'reminder_sent';
  category: 'file' | 'todo' | 'security' | 'performance' | 'general';
  content: string;
  bookmark?: Bookmark;
}

export interface MonitorContextCompressionEvent {
  channel: 'monitor';
  type: 'context_compression';
  phase: 'start' | 'end';
  summary?: string;
  ratio?: number;
  bookmark?: Bookmark;
}

export interface MonitorSchedulerTriggeredEvent {
  channel: 'monitor';
  type: 'scheduler_triggered';
  taskId: string;
  spec: string;
  kind: 'steps' | 'time' | 'cron';
  triggeredAt: number;
  bookmark?: Bookmark;
}

export interface MonitorToolManualUpdatedEvent {
  channel: 'monitor';
  type: 'tool_manual_updated';
  tools: string[];
  timestamp: number;
  bookmark?: Bookmark;
}

export interface MonitorSkillsMetadataUpdatedEvent {
  channel: 'monitor';
  type: 'skills_metadata_updated';
  skills: string[];
  timestamp: number;
  bookmark?: Bookmark;
}

export interface MonitorToolCustomEvent {
  channel: 'monitor';
  type: 'tool_custom_event';
  toolName: string;
  eventType: string;
  data?: any;
  timestamp: number;
  bookmark?: Bookmark;
}

export type MonitorEvent =
  | MonitorStateChangedEvent
  | MonitorStepCompleteEvent
  | MonitorErrorEvent
  | MonitorTokenUsageEvent
  | MonitorToolExecutedEvent
  | MonitorAgentResumedEvent
  | MonitorTodoChangedEvent
  | MonitorTodoReminderEvent
  | MonitorFileChangedEvent
  | MonitorReminderSentEvent
  | MonitorContextCompressionEvent
  | MonitorSchedulerTriggeredEvent
  | MonitorBreakpointChangedEvent
  | MonitorToolManualUpdatedEvent
  | MonitorSkillsMetadataUpdatedEvent
  | MonitorToolCustomEvent;

export type AgentEvent = ProgressEvent | ControlEvent | MonitorEvent;

export interface AgentEventEnvelope<T extends AgentEvent = AgentEvent> {
  cursor: number;
  bookmark: Bookmark;
  event: T;
}

export interface Timeline {
  cursor: number;
  bookmark: Bookmark;
  event: AgentEvent;
}

export type SnapshotId = string;

export interface Snapshot {
  id: SnapshotId;
  messages: Message[];
  lastSfpIndex: number;
  lastBookmark: Bookmark;
  createdAt: string;
  metadata?: Record<string, any>;
}

export interface AgentStatus {
  agentId: string;
  state: AgentRuntimeState;
  stepCount: number;
  lastSfpIndex: number;
  lastBookmark?: Bookmark;
  cursor: number;
  breakpoint: BreakpointState;
}

export interface AgentInfo {
  agentId: string;
  templateId: string;
  createdAt: string;
  lineage: string[];
  configVersion: string;
  messageCount: number;
  lastSfpIndex: number;
  lastBookmark?: Bookmark;
  breakpoint?: BreakpointState;
  metadata?: Record<string, any>;
}

export interface ReminderOptions {
  skipStandardEnding?: boolean;
  priority?: 'low' | 'medium' | 'high';
  category?: 'file' | 'todo' | 'security' | 'performance' | 'general';
}

export type ResumeStrategy = 'crash' | 'manual';

export interface ToolOutcome {
  id: string;
  name: string;
  ok: boolean;
  content: any;
  durationMs?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  agentId: string;
}

export type HookDecision =
  | { decision: 'ask'; meta?: any }
  | { decision: 'deny'; reason?: string; toolResult?: any }
  | { result: any }
  | void;

export type PostHookResult =
  | void
  | { update: Partial<ToolOutcome> }
  | { replace: ToolOutcome };

export interface ToolContext {
  agentId: string;
  sandbox: import('../infra/sandbox').Sandbox;
  agent: any;
  services?: Record<string, any>;
  signal?: AbortSignal;
  emit?: (eventType: string, data?: any) => void;
}
