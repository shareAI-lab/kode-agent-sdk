import { EventEmitter } from 'events';

import {
  AgentEvent,
  AgentEventEnvelope,
  AgentInfo,
  AgentRuntimeState,
  AgentStatus,
  Bookmark,
  BreakpointState,
  ContentBlock,
  ControlEvent,
  HookDecision,
  Message,
  MonitorEvent,
  ProgressEvent,
  ReminderOptions,
  ResumeStrategy,
  Snapshot,
  SnapshotId,
  ToolCallApproval,
  ToolCallRecord,
  ToolCallSnapshot,
  ToolCallState,
  ToolContext,
  ToolOutcome,
} from './types';
import { EventBus } from './events';
import { HookManager, Hooks } from './hooks';
import { Scheduler } from './scheduler';
import { ContextManager } from './context-manager';
import { FilePool } from './file-pool';
import Ajv, { ValidateFunction } from 'ajv';
import { TodoService, TodoInput, TodoItem } from './todo';
import { AgentTemplateRegistry, AgentTemplateDefinition, PermissionConfig, SubAgentConfig, TodoConfig } from './template';
import { Store } from '../infra/store';
import { Sandbox, SandboxKind } from '../infra/sandbox';
import { SandboxFactory } from '../infra/sandbox-factory';
import { ModelProvider, ModelConfig, AnthropicProvider, OpenRouterProvider } from '../infra/provider';
import { ToolRegistry, ToolInstance, ToolDescriptor } from '../tools/registry';
import { Configurable } from './config';
import { ContextManagerOptions } from './context-manager';
import { BreakpointManager } from './agent/breakpoint-manager';
import { PermissionManager } from './agent/permission-manager';
import { TodoRead } from '../tools/todo_read';
import { TodoWrite } from '../tools/todo_write';
import { ResumeError } from './errors';
import { MessageQueue, SendOptions as QueueSendOptions } from './agent/message-queue';
import { TodoManager } from './agent/todo-manager';
import { ToolRunner } from './agent/tool-runner';
import { logger } from '../utils/logger';

const CONFIG_VERSION = 'v2.7.0';

export interface ModelFactory {
  (config: ModelConfig): ModelProvider;
}

export interface AgentDependencies {
  store: Store;
  templateRegistry: AgentTemplateRegistry;
  sandboxFactory: SandboxFactory;
  toolRegistry: ToolRegistry;
  modelFactory?: ModelFactory;
  skillsManager?: import('./skills/manager').SkillsManager;
}

export type SendOptions = QueueSendOptions;

export interface SandboxConfig {
  kind: SandboxKind;
  workDir?: string;
  enforceBoundary?: boolean;
  allowPaths?: string[];
  watchFiles?: boolean;
  [key: string]: any;
}

export interface AgentConfig {
  agentId?: string;
  templateId: string;
  templateVersion?: string;
  model?: ModelProvider;
  modelConfig?: ModelConfig;
  sandbox?: Sandbox | SandboxConfig;
  tools?: string[];
  exposeThinking?: boolean;
  overrides?: {
    permission?: PermissionConfig;
    todo?: TodoConfig;
    subagents?: SubAgentConfig;
    hooks?: Hooks;
  };
  context?: ContextManagerOptions;
  metadata?: Record<string, any>;
}

interface AgentMetadata {
  agentId: string;
  templateId: string;
  templateVersion?: string;
  sandboxConfig?: SandboxConfig;
  modelConfig?: ModelConfig;
  tools: ToolDescriptor[];
  exposeThinking: boolean;
  permission?: PermissionConfig;
  todo?: TodoConfig;
  subagents?: SubAgentConfig;
  context?: ContextManagerOptions;
  createdAt: string;
  updatedAt: string;
  configVersion: string;
  metadata?: Record<string, any>;
  lineage?: string[];
  breakpoint?: BreakpointState;
}

interface PendingPermission {
  resolve(decision: 'allow' | 'deny', note?: string): void;
}

interface SubAgentRuntime {
  depthRemaining: number;
}

export interface CompleteResult {
  status: 'ok' | 'paused';
  text?: string;
  last?: Bookmark;
  permissionIds?: string[];
}

export interface StreamOptions {
  since?: Bookmark;
  kinds?: Array<ProgressEvent['type']>;
}

export interface SubscribeOptions {
  since?: Bookmark;
  kinds?: Array<AgentEvent['type']>;
}

export class Agent {
  private readonly events = new EventBus();
  private readonly hooks = new HookManager();
  private readonly scheduler: Scheduler;
  private readonly todoService?: TodoService;
  private readonly contextManager: ContextManager;
  private readonly filePool: FilePool;
  private readonly breakpoints: BreakpointManager;
  private readonly permissions: PermissionManager;
  private readonly model: ModelProvider;
  private readonly sandbox: Sandbox;
  private readonly sandboxConfig?: SandboxConfig;
  private readonly todoConfig?: TodoConfig;
  private readonly messageQueue: MessageQueue;
  private readonly todoManager: TodoManager;
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly validatorCache = new Map<string, ValidateFunction>();
  private readonly toolControllers = new Map<string, AbortController>();
  private readonly toolTimeoutMs: number;
  private readonly maxToolConcurrency: number;
  private readonly tools = new Map<string, ToolInstance>();
  private readonly toolDescriptors: ToolDescriptor[] = [];
  private readonly toolDescriptorIndex = new Map<string, ToolDescriptor>();

  private skillsManager?: import('./skills/manager').SkillsManager;

  private createdAt: string;

  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly toolRunner: ToolRunner;

  private messages: Message[] = [];
  private state: AgentRuntimeState = 'READY';
  private toolRecords = new Map<string, ToolCallRecord>();
  private interrupted = false;
  private processingPromise: Promise<void> | null = null;
  private pendingNextRound: boolean = false; // 标志位：表示是否需要下一轮处理
  private lastProcessingStart = 0;
  private readonly PROCESSING_TIMEOUT = 5 * 60 * 1000; // 5 分钟
  private stepCount = 0;
  private lastSfpIndex = -1;
  private lastBookmark?: Bookmark;
  private exposeThinking: boolean;
  private permission: PermissionConfig;
  private subagents?: SubAgentConfig;
  private template: AgentTemplateDefinition;
  private lineage: string[] = [];

  private get persistentStore(): Store {
    if (!this.deps.store) {
      throw new Error('Agent persistent store is not configured for this operation.');
    }
    return this.deps.store;
  }

  private static requireStore(deps: AgentDependencies): Store {
    if (!deps.store) {
      throw new ResumeError('CORRUPTED_DATA', 'Agent store is not configured.');
    }
    return deps.store;
  }

  constructor(
    private readonly config: AgentConfig,
    private readonly deps: AgentDependencies,
    runtime: {
      template: AgentTemplateDefinition;
      model: ModelProvider;
      sandbox: Sandbox;
      sandboxConfig?: SandboxConfig;
      tools: ToolInstance[];
      toolDescriptors: ToolDescriptor[];
      permission: PermissionConfig;
      todoConfig?: TodoConfig;
      subagents?: SubAgentConfig;
      context?: ContextManagerOptions;
    }
  ) {
    Agent.requireStore(this.deps);
    this.template = runtime.template;
    this.model = runtime.model;
    this.sandbox = runtime.sandbox;
    this.sandboxConfig = runtime.sandboxConfig;
    this.permission = runtime.permission;
    this.subagents = runtime.subagents;
    this.exposeThinking = config.exposeThinking ?? runtime.template.runtime?.exposeThinking ?? false;
    this.toolDescriptors = runtime.toolDescriptors;
    for (const descriptor of this.toolDescriptors) {
      this.toolDescriptorIndex.set(descriptor.name, descriptor);
    }
    this.todoConfig = runtime.todoConfig;
    this.permissions = new PermissionManager(this.permission, this.toolDescriptorIndex);

    // 保存SkillsManager引用
    this.skillsManager = deps.skillsManager;
    this.scheduler = new Scheduler({
      onTrigger: (info) => {
        this.events.emitMonitor({
          channel: 'monitor',
          type: 'scheduler_triggered',
          taskId: info.taskId,
          spec: info.spec,
          kind: info.kind,
          triggeredAt: Date.now(),
        });
      },
    });
    const runtimeMeta = { ...(this.template.runtime?.metadata || {}), ...(config.metadata || {}) } as Record<string, any>;
    this.createdAt = new Date().toISOString();
    this.toolTimeoutMs = typeof runtimeMeta.toolTimeoutMs === 'number' ? runtimeMeta.toolTimeoutMs : 60000;
    this.maxToolConcurrency = typeof runtimeMeta.maxToolConcurrency === 'number' ? runtimeMeta.maxToolConcurrency : 3;
    this.toolRunner = new ToolRunner(Math.max(1, this.maxToolConcurrency));

    for (const tool of runtime.tools) {
      this.tools.set(tool.name, tool);
      if (tool.hooks) {
        this.hooks.register(tool.hooks, 'toolTune');
      }
    }

    if (this.template.hooks) {
      this.hooks.register(this.template.hooks, 'agent');
    }
    if (config.overrides?.hooks) {
      this.hooks.register(config.overrides.hooks, 'agent');
    }

    this.breakpoints = new BreakpointManager((previous, current, entry) => {
      this.events.emitMonitor({
        channel: 'monitor',
        type: 'breakpoint_changed',
        previous,
        current,
        timestamp: entry.timestamp,
      });
    });
    this.breakpoints.set('READY');

    if (runtime.todoConfig?.enabled) {
      this.todoService = new TodoService(this.persistentStore, this.agentId);
    }

    this.filePool = new FilePool(this.sandbox, {
      watch: this.sandboxConfig?.watchFiles !== false,
      onChange: (event) => this.handleExternalFileChange(event.path, event.mtime),
    });
    this.contextManager = new ContextManager(this.persistentStore, this.agentId, runtime.context);

    this.messageQueue = new MessageQueue({
      wrapReminder: this.wrapReminder.bind(this),
      addMessage: (message, kind) => this.enqueueMessage(message, kind),
      persist: () => this.persistMessages(),
      ensureProcessing: () => this.ensureProcessing(),
    });

    this.todoManager = new TodoManager({
      service: this.todoService,
      config: this.todoConfig,
      events: this.events,
      remind: (content, options) => this.remind(content, options),
    });

    this.events.setStore(this.persistentStore, this.agentId);

    // 自动注入工具说明书到系统提示
    this.injectManualIntoSystemPrompt();
  }

  get agentId(): string {
    return this.config.agentId!;
  }

  static async create(config: AgentConfig, deps: AgentDependencies): Promise<Agent> {
    if (!config.agentId) {
      config.agentId = Agent.generateAgentId();
    }

    const template = deps.templateRegistry.get(config.templateId);

    const sandboxConfig: SandboxConfig | undefined =
      config.sandbox && 'kind' in config.sandbox
        ? (config.sandbox as SandboxConfig)
        : (template.sandbox as SandboxConfig | undefined);

    const sandbox = typeof config.sandbox === 'object' && 'exec' in config.sandbox
      ? (config.sandbox as Sandbox)
      : deps.sandboxFactory.create(sandboxConfig || { kind: 'local', workDir: process.cwd() });

    const model = config.model
      ? config.model
      : config.modelConfig
      ? ensureModelFactory(deps.modelFactory)(config.modelConfig)
      : template.model
      ? ensureModelFactory(deps.modelFactory)({ provider: 'anthropic', model: template.model })
      : ensureModelFactory(deps.modelFactory)({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' });

    const resolvedTools = resolveTools(config, template, deps.toolRegistry, deps.templateRegistry);

    const permissionConfig = config.overrides?.permission || template.permission || { mode: 'auto' };
    const normalizedPermission: PermissionConfig = {
      ...permissionConfig,
      mode: permissionConfig.mode || 'auto',
    };

    const agent = new Agent(config, deps, {
      template,
      model,
      sandbox,
      sandboxConfig,
      tools: resolvedTools.instances,
      toolDescriptors: resolvedTools.descriptors,
      permission: normalizedPermission,
      todoConfig: config.overrides?.todo || template.runtime?.todo,
      subagents: config.overrides?.subagents || template.runtime?.subagents,
      context: config.context || template.runtime?.metadata?.context,
    });

    await agent.initialize();
    return agent;
  }

  private async initialize(): Promise<void> {
    await this.todoService?.load();
    const messages = await this.persistentStore.loadMessages(this.agentId);
    this.messages = messages;
    this.lastSfpIndex = this.findLastSfp();
    this.stepCount = messages.filter((m) => m.role === 'user').length;
    const records = await this.persistentStore.loadToolCallRecords(this.agentId);
    this.toolRecords = new Map(records.map((record) => [record.id, this.normalizeToolRecord(record)]));
    if (this.todoService) {
      this.registerTodoTools();
      this.todoManager.handleStartup();
    }
    await this.persistInfo();

    // 注入skills元数据（异步，等待完成）
    await this.injectSkillsMetadataIntoSystemPrompt();
  }

  async *chatStream(input: string, opts?: StreamOptions): AsyncIterable<AgentEventEnvelope<ProgressEvent>> {
    const since = opts?.since ?? this.events.getLastBookmark();
    await this.send(input);

    const subscription = this.events.subscribeProgress({ since, kinds: opts?.kinds });
    for await (const event of subscription) {
      yield event;
      if (event.event.type === 'done') {
        this.lastBookmark = event.bookmark;
        break;
      }
    }
  }

  async chat(input: string, opts?: StreamOptions): Promise<CompleteResult> {
    let streamedText = '';
    let bookmark: Bookmark | undefined;
    for await (const envelope of this.chatStream(input, opts)) {
      if (envelope.event.type === 'text_chunk') {
        streamedText += envelope.event.delta;
      }
      if (envelope.event.type === 'done') {
        bookmark = envelope.bookmark;
      }
    }

    const pending = Array.from(this.pendingPermissions.keys());

    let finalText = streamedText;
    const lastAssistant = [...this.messages].reverse().find((message) => message.role === 'assistant');
    if (lastAssistant) {
      const combined = lastAssistant.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      if (combined.trim().length > 0) {
        finalText = combined;
      }
    }

    return {
      status: pending.length ? 'paused' : 'ok',
      text: finalText,
      last: bookmark,
      permissionIds: pending,
    };
  }

  async complete(input: string, opts?: StreamOptions): Promise<CompleteResult> {
    return this.chat(input, opts);
  }

  async *stream(input: string, opts?: StreamOptions): AsyncIterable<AgentEventEnvelope<ProgressEvent>> {
    yield* this.chatStream(input, opts);
  }

  async send(text: string, options?: SendOptions): Promise<string> {
    return this.messageQueue.send(text, options);
  }

  schedule(): Scheduler {
    return this.scheduler;
  }

  on<T extends ControlEvent['type'] | MonitorEvent['type']>(event: T, handler: (evt: any) => void): () => void {
    if (event === 'permission_required' || event === 'permission_decided') {
      return this.events.onControl(event as ControlEvent['type'], handler as any);
    }
    return this.events.onMonitor(event as MonitorEvent['type'], handler as any);
  }

  subscribe(channels?: Array<'progress' | 'control' | 'monitor'>, opts?: SubscribeOptions) {
    if (!opts || (!opts.since && !opts.kinds)) {
      return this.events.subscribe(channels);
    }
    return this.events.subscribe(channels, { since: opts.since, kinds: opts.kinds });
  }

  getTodos(): TodoItem[] {
    return this.todoManager.list();
  }

  async setTodos(todos: TodoInput[]): Promise<void> {
    await this.todoManager.setTodos(todos);
  }

  async updateTodo(todo: TodoInput): Promise<void> {
    await this.todoManager.update(todo);
  }

  async deleteTodo(id: string): Promise<void> {
    await this.todoManager.remove(id);
  }

  async decide(permissionId: string, decision: 'allow' | 'deny', note?: string): Promise<void> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) throw new Error(`Permission not pending: ${permissionId}`);
    pending.resolve(decision, note);
    this.pendingPermissions.delete(permissionId);
    this.events.emitControl({
      channel: 'control',
      type: 'permission_decided',
      callId: permissionId,
      decision,
      decidedBy: 'api',
      note,
    });
    if (decision === 'allow') {
      this.setState('WORKING');
      this.setBreakpoint('PRE_TOOL');
      this.ensureProcessing();
    } else {
      this.setBreakpoint('POST_TOOL');
      this.setState('READY');
    }
  }

  async interrupt(opts?: { note?: string }): Promise<void> {
    this.interrupted = true;
    this.toolRunner.clear();
    for (const controller of this.toolControllers.values()) {
      controller.abort();
    }
    this.toolControllers.clear();
    await this.appendSyntheticToolResults(opts?.note || 'Interrupted by user');
    this.setState('READY');
    this.setBreakpoint('READY');
  }

  async snapshot(label?: string): Promise<SnapshotId> {
    const id = label || `sfp:${this.lastSfpIndex}`;
    const snapshot: Snapshot = {
      id,
      messages: JSON.parse(JSON.stringify(this.messages)),
      lastSfpIndex: this.lastSfpIndex,
      lastBookmark: this.lastBookmark ?? { seq: -1, timestamp: Date.now() },
      createdAt: new Date().toISOString(),
      metadata: {
        stepCount: this.stepCount,
      },
    };
    await this.persistentStore.saveSnapshot(this.agentId, snapshot);
    return id;
  }

  async fork(sel?: SnapshotId | { at?: string }): Promise<Agent> {
    const snapshotId = typeof sel === 'string' ? sel : sel?.at ?? (await this.snapshot());
    const snapshot = await this.persistentStore.loadSnapshot(this.agentId, snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);

    const forkId = `${this.agentId}/fork:${Date.now()}`;
    const forkConfig: AgentConfig = {
      ...this.config,
      agentId: forkId,
    };
    const fork = await Agent.create(forkConfig, this.deps);
    fork.messages = JSON.parse(JSON.stringify(snapshot.messages));
    fork.lastSfpIndex = snapshot.lastSfpIndex;
    fork.stepCount = snapshot.metadata?.stepCount ?? fork.messages.filter((m) => m.role === 'user').length;
    fork.lineage = [...this.lineage, this.agentId];
    await fork.persistMessages();
    return fork;
  }

  async status(): Promise<AgentStatus> {
    return {
      agentId: this.agentId,
      state: this.state,
      stepCount: this.stepCount,
      lastSfpIndex: this.lastSfpIndex,
      lastBookmark: this.lastBookmark,
      cursor: this.events.getCursor(),
      breakpoint: this.breakpoints.getCurrent(),
    };
  }

  async info(): Promise<AgentInfo> {
    return {
      agentId: this.agentId,
      templateId: this.template.id,
      createdAt: this.createdAt,
      lineage: this.lineage,
      configVersion: CONFIG_VERSION,
      messageCount: this.messages.length,
      lastSfpIndex: this.lastSfpIndex,
      lastBookmark: this.lastBookmark,
      breakpoint: this.breakpoints.getCurrent(),
    };
  }

  private setBreakpoint(state: BreakpointState, note?: string) {
    this.breakpoints.set(state, note);
  }

  remind(content: string, options?: ReminderOptions) {
    this.messageQueue.send(content, { kind: 'reminder', reminder: options });
    this.events.emitMonitor({
      channel: 'monitor',
      type: 'reminder_sent',
      category: options?.category ?? 'general',
      content,
    });
  }

  async spawnSubAgent(templateId: string, prompt: string, runtime?: SubAgentRuntime): Promise<CompleteResult> {
    if (!this.subagents) {
      throw new Error('Sub-agent configuration not enabled for this agent');
    }
    const remaining = runtime?.depthRemaining ?? this.subagents.depth;
    if (remaining <= 0) {
      throw new Error('Sub-agent recursion limit reached');
    }
    if (this.subagents.templates && !this.subagents.templates.includes(templateId)) {
      throw new Error(`Template ${templateId} not allowed for sub-agent`);
    }

    const subConfig: AgentConfig = {
      templateId,
      modelConfig: this.model.toConfig(),
      sandbox: this.sandboxConfig || { kind: 'local', workDir: this.sandbox.workDir },
      exposeThinking: this.exposeThinking,
      metadata: this.config.metadata,
      overrides: {
        permission: this.subagents.overrides?.permission || this.permission,
        todo: this.subagents.overrides?.todo || this.template.runtime?.todo,
        subagents: this.subagents.inheritConfig ? { ...this.subagents, depth: remaining - 1 } : undefined,
      },
    };

    const subAgent = await Agent.create(subConfig, this.deps);
    subAgent.lineage = [...this.lineage, this.agentId];
    const result = await subAgent.complete(prompt);
    return result;
  }

  /**
   * Create and run a sub-agent with a task, without requiring subagents config.
   * This is useful for tools that want to delegate work to specialized agents.
   */
  async delegateTask(config: {
    templateId: string;
    prompt: string;
    model?: string;
    tools?: string[];
  }): Promise<CompleteResult> {
    const subAgentConfig: AgentConfig = {
      templateId: config.templateId,
      modelConfig: config.model
        ? { provider: 'anthropic', model: config.model }
        : this.model.toConfig(),
      sandbox: this.sandboxConfig || { kind: 'local', workDir: this.sandbox.workDir },
      tools: config.tools,
      metadata: {
        ...this.config.metadata,
        parentAgentId: this.agentId,
        delegatedBy: 'task_tool',
      },
    };

    const subAgent = await Agent.create(subAgentConfig, this.deps);
    subAgent.lineage = [...this.lineage, this.agentId];
    const result = await subAgent.complete(config.prompt);
    return result;
  }

  static async resume(agentId: string, config: AgentConfig, deps: AgentDependencies, opts?: { autoRun?: boolean; strategy?: ResumeStrategy }): Promise<Agent> {
    const store = Agent.requireStore(deps);
    const info = await store.loadInfo(agentId);
    if (!info) {
      throw new ResumeError('AGENT_NOT_FOUND', `Agent metadata not found: ${agentId}`);
    }
    const metadata = info.metadata as AgentMetadata | undefined;
    if (!metadata) {
      throw new ResumeError('CORRUPTED_DATA', `Agent metadata incomplete for: ${agentId}`);
    }

    const templateId = metadata.templateId;
    let template: AgentTemplateDefinition;
    try {
      template = deps.templateRegistry.get(templateId);
    } catch (error: any) {
      throw new ResumeError('TEMPLATE_NOT_FOUND', `Template not registered: ${templateId}`);
    }

    if (config.templateVersion && metadata.templateVersion && config.templateVersion !== metadata.templateVersion) {
      throw new ResumeError(
        'TEMPLATE_VERSION_MISMATCH',
        `Template version mismatch: expected ${config.templateVersion}, got ${metadata.templateVersion}`
      );
    }

    let sandbox: Sandbox;
    try {
      sandbox = deps.sandboxFactory.create(metadata.sandboxConfig || { kind: 'local', workDir: process.cwd() });
    } catch (error: any) {
      throw new ResumeError('SANDBOX_INIT_FAILED', error?.message || 'Failed to create sandbox');
    }
    const model = metadata.modelConfig
      ? ensureModelFactory(deps.modelFactory)(metadata.modelConfig)
      : ensureModelFactory(deps.modelFactory)({ provider: 'anthropic', model: template.model || 'claude-sonnet-4-5-20250929' });

    const toolInstances = metadata.tools.map((descriptor) => {
      try {
        return deps.toolRegistry.create(descriptor.registryId || descriptor.name, descriptor.config);
      } catch (error: any) {
        throw new ResumeError(
          'CORRUPTED_DATA',
          `Failed to restore tool ${descriptor.name}: ${error?.message || error}`
        );
      }
    });

    const permissionConfig = metadata.permission || template.permission || { mode: 'auto' };
    const normalizedPermission: PermissionConfig = {
      ...permissionConfig,
      mode: permissionConfig.mode || 'auto',
    };

    const agent = new Agent(
      { ...config, agentId, templateId: templateId, exposeThinking: metadata.exposeThinking },
      deps,
      {
        template,
        model,
        sandbox,
        sandboxConfig: metadata.sandboxConfig,
        tools: toolInstances,
        toolDescriptors: metadata.tools,
        permission: normalizedPermission,
        todoConfig: metadata.todo,
        subagents: metadata.subagents,
        context: metadata.context,
      }
    );

    agent.lineage = metadata.lineage || [];
    agent.createdAt = metadata.createdAt || agent.createdAt;
    await agent.initialize();
    if (metadata.breakpoint) {
      agent.breakpoints.reset(metadata.breakpoint);
    }

    let messages: Message[];
    try {
      messages = await store.loadMessages(agentId);
    } catch (error: any) {
      throw new ResumeError('CORRUPTED_DATA', error?.message || 'Failed to load messages');
    }
    agent.messages = messages;
    agent.lastSfpIndex = agent.findLastSfp();
    agent.stepCount = messages.filter((m) => m.role === 'user').length;
    const toolRecords = await store.loadToolCallRecords(agentId);
    agent.toolRecords = new Map(toolRecords.map((record) => [record.id, agent.normalizeToolRecord(record)]));

    if (opts?.strategy === 'crash') {
      const sealed = await agent.autoSealIncompleteCalls();
      agent.events.emitMonitor({
        channel: 'monitor',
        type: 'agent_resumed',
        strategy: 'crash',
        sealed,
      });
    } else {
      agent.events.emitMonitor({
        channel: 'monitor',
        type: 'agent_resumed',
        strategy: 'manual',
        sealed: [],
      });
    }

    if (opts?.autoRun) {
      agent.ensureProcessing();
    }

    return agent;
  }

  static async resumeFromStore(
    agentId: string,
    deps: AgentDependencies,
    opts?: { autoRun?: boolean; strategy?: ResumeStrategy; overrides?: Partial<AgentConfig> }
  ): Promise<Agent> {
    const store = Agent.requireStore(deps);
    const info = await store.loadInfo(agentId);
    if (!info || !info.metadata) {
      throw new ResumeError('AGENT_NOT_FOUND', `Agent metadata not found: ${agentId}`);
    }
    const metadata = info.metadata as AgentMetadata;
    const baseConfig: AgentConfig = {
      agentId,
      templateId: metadata.templateId,
      templateVersion: metadata.templateVersion,
      modelConfig: metadata.modelConfig,
      sandbox: metadata.sandboxConfig,
      exposeThinking: metadata.exposeThinking,
      context: metadata.context,
      metadata: metadata.metadata,
      overrides: {
        permission: metadata.permission,
        todo: metadata.todo,
        subagents: metadata.subagents,
      },
      tools: metadata.tools.map((descriptor) => descriptor.registryId || descriptor.name),
    };
    const overrides = opts?.overrides ?? {};
    return Agent.resume(agentId, { ...baseConfig, ...overrides }, deps, opts);
  }

  private ensureProcessing() {
    // 检查是否超时
    if (this.processingPromise) {
      const now = Date.now();
      if (now - this.lastProcessingStart > this.PROCESSING_TIMEOUT) {
        this.events.emitMonitor({
          channel: 'monitor',
          type: 'error',
          severity: 'error',
          phase: 'lifecycle',
          message: 'Processing timeout detected, forcing restart',
          detail: {
            lastStart: this.lastProcessingStart,
            elapsed: now - this.lastProcessingStart
          }
        });
        this.processingPromise = null; // 强制重启
      } else {
        // 正常执行中，设置标志位表示需要下一轮
        this.pendingNextRound = true;
        return;
      }
    }

    // 清除标志位，准备启动新的处理
    this.pendingNextRound = false;

    this.lastProcessingStart = Date.now();
    this.processingPromise = this.runStep()
      .finally(() => {
        this.processingPromise = null;
        // 如果有下一轮待处理，启动它
        if (this.pendingNextRound) {
          this.ensureProcessing();
        }
      })
      .catch((err) => {
        // 确保异常不会导致状态卡住
        this.events.emitMonitor({
          channel: 'monitor',
          type: 'error',
          severity: 'error',
          phase: 'lifecycle',
          message: 'Processing failed',
          detail: { error: err.message, stack: err.stack }
        });
        this.setState('READY');
        this.setBreakpoint('READY');
      });
  }

  private async runStep(): Promise<void> {
    if (this.state !== 'READY') return;
    if (this.interrupted) {
      this.interrupted = false;
      return;
    }

    this.setState('WORKING');
    this.setBreakpoint('PRE_MODEL');

    try {
      await this.messageQueue.flush();
      const usage = this.contextManager.analyze(this.messages);
      if (usage.shouldCompress) {
        this.events.emitMonitor({
          channel: 'monitor',
          type: 'context_compression',
          phase: 'start',
        });

        const compression = await this.contextManager.compress(
          this.messages,
          this.events.getTimeline(),
          this.filePool,
          this.sandbox
        );

        if (compression) {
          this.messages = [...compression.retainedMessages];
          this.messages.unshift(compression.summary);
          this.lastSfpIndex = this.messages.length - 1;
          await this.persistMessages();
          this.events.emitMonitor({
            channel: 'monitor',
            type: 'context_compression',
            phase: 'end',
            summary: compression.summary.content.map((block) => (block.type === 'text' ? block.text : JSON.stringify(block))).join('\n'),
            ratio: compression.ratio,
          });
        }
      }

      await this.hooks.runPreModel(this.messages);

      this.setBreakpoint('STREAMING_MODEL');
      const stream = this.model.stream(this.messages, {
        tools: this.getToolSchemas(),
        maxTokens: this.config.metadata?.maxTokens,
        temperature: this.config.metadata?.temperature,
        system: this.template.systemPrompt,
      });

      const assistantBlocks: ContentBlock[] = [];
      let currentBlockIndex = -1;
      let currentToolBuffer = '';
      const textBuffers = new Map<number, string>();

      if (this.exposeThinking) {
        this.events.emitProgress({ channel: 'progress', type: 'think_chunk_start', step: this.stepCount });
      }

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_start') {
          if (chunk.content_block?.type === 'text') {
            currentBlockIndex = chunk.index ?? 0;
            assistantBlocks[currentBlockIndex] = { type: 'text', text: '' };
            this.events.emitProgress({ channel: 'progress', type: 'text_chunk_start', step: this.stepCount });
          } else if (chunk.content_block?.type === 'tool_use') {
            currentBlockIndex = chunk.index ?? 0;
            currentToolBuffer = '';
            assistantBlocks[currentBlockIndex] = {
              type: 'tool_use',
              id: (chunk.content_block as any).id,
              name: (chunk.content_block as any).name,
              input: {},
            };
          }
        } else if (chunk.type === 'content_block_delta') {
          if (chunk.delta?.type === 'text_delta') {
            const text = chunk.delta.text ?? '';
            const existing = textBuffers.get(currentBlockIndex) ?? '';
            textBuffers.set(currentBlockIndex, existing + text);
            if (assistantBlocks[currentBlockIndex]?.type === 'text') {
              (assistantBlocks[currentBlockIndex] as any).text = existing + text;
            }
            this.events.emitProgress({ channel: 'progress', type: 'text_chunk', step: this.stepCount, delta: text });
          } else if (chunk.delta?.type === 'input_json_delta') {
            currentToolBuffer += chunk.delta.partial_json ?? '';
            try {
              const parsed = JSON.parse(currentToolBuffer);
              if (assistantBlocks[currentBlockIndex]?.type === 'tool_use') {
                (assistantBlocks[currentBlockIndex] as any).input = parsed;
              }
            } catch {
              // continue buffering
            }
          }
        } else if (chunk.type === 'message_delta') {
          const inputTokens = (chunk.usage as any)?.input_tokens ?? 0;
          const outputTokens = (chunk.usage as any)?.output_tokens ?? 0;
          if (inputTokens || outputTokens) {
            this.events.emitMonitor({
              channel: 'monitor',
              type: 'token_usage',
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
            });
          }
        } else if (chunk.type === 'content_block_stop') {
          if (assistantBlocks[currentBlockIndex]?.type === 'text') {
            const fullText = textBuffers.get(currentBlockIndex) ?? '';
            this.events.emitProgress({ channel: 'progress', type: 'text_chunk_end', step: this.stepCount, text: fullText });
          }
          currentBlockIndex = -1;
          currentToolBuffer = '';
        }
      }

      if (this.exposeThinking) {
        this.events.emitProgress({ channel: 'progress', type: 'think_chunk_end', step: this.stepCount });
      }

      await this.hooks.runPostModel({ role: 'assistant', content: assistantBlocks } as any);

      this.messages.push({ role: 'assistant', content: assistantBlocks });
      await this.persistMessages();

      const toolBlocks = assistantBlocks.filter((block) => block.type === 'tool_use');
      if (toolBlocks.length > 0) {
        this.setBreakpoint('TOOL_PENDING');
        const outcomes = await this.executeTools(toolBlocks);
        if (outcomes.length > 0) {
          this.messages.push({ role: 'user', content: outcomes });
          this.lastSfpIndex = this.messages.length - 1;
          this.stepCount++;
          await this.persistMessages();
          this.todoManager.onStep();
          this.ensureProcessing();
          return;
        }
      } else {
        this.lastSfpIndex = this.messages.length - 1;
      }

      const envelope = this.events.emitProgress({
        channel: 'progress',
        type: 'done',
        step: this.stepCount,
        reason: this.pendingPermissions.size > 0 ? 'interrupted' : 'completed',
      });
      this.lastBookmark = envelope.bookmark;
      this.stepCount++;
      this.scheduler.notifyStep(this.stepCount);
      this.todoManager.onStep();
      this.events.emitMonitor({ channel: 'monitor', type: 'step_complete', step: this.stepCount, bookmark: envelope.bookmark });
    } catch (error: any) {
      this.events.emitMonitor({
        channel: 'monitor',
        type: 'error',
        severity: 'error',
        phase: 'model',
        message: error?.message || 'Model execution failed',
        detail: { stack: error?.stack },
      });
    } finally {
      this.setState('READY');
      this.setBreakpoint('READY');
    }
  }

  private async executeTools(toolUses: ContentBlock[]): Promise<ContentBlock[]> {
    const uses = toolUses.filter((block) => block.type === 'tool_use') as Array<{
      type: 'tool_use';
      id: string;
      name: string;
      input: any;
    }>;

    if (uses.length === 0) {
      return [];
    }

    const results = new Map<string, ContentBlock | null>();

    await Promise.all(
      uses.map((use) =>
        this.toolRunner.run(async () => {
          const result = await this.processToolCall(use);
          if (result) {
            results.set(use.id, result);
          }
        })
      )
    );

    await this.persistToolRecords();

    const ordered: ContentBlock[] = [];
    for (const use of uses) {
      const block = results.get(use.id);
      if (block) {
        ordered.push(block);
      }
    }
    return ordered;
  }

  private async processToolCall(toolUse: { id: string; name: string; input: any }): Promise<ContentBlock | null> {
    const tool = this.tools.get(toolUse.name);
    const record = this.registerToolRecord(toolUse);
    this.events.emitProgress({ channel: 'progress', type: 'tool:start', call: this.snapshotToolRecord(record.id) });

    if (!tool) {
      const message = `Tool not found: ${toolUse.name}`;
      this.updateToolRecord(record.id, { state: 'FAILED', error: message, isError: true }, 'tool missing');
      this.events.emitMonitor({ channel: 'monitor', type: 'error', severity: 'warn', phase: 'tool', message });
      return this.makeToolResult(toolUse.id, {
        ok: false,
        error: message,
        recommendations: ['确认工具是否已注册', '检查模板或配置中的工具列表'],
      });
    }

    const validation = this.validateToolArgs(tool, toolUse.input);
    if (!validation.ok) {
      const message = validation.error || 'Tool input validation failed';
      this.updateToolRecord(record.id, { state: 'FAILED', error: message, isError: true }, 'input schema invalid');
      return this.makeToolResult(toolUse.id, {
        ok: false,
        error: message,
        recommendations: ['检查工具入参是否符合 schema', '根据提示修正参数后重试'],
      });
    }

    const context: ToolContext = {
      agentId: this.agentId,
      sandbox: this.sandbox,
      agent: this,
      services: {
        todo: this.todoService,
        filePool: this.filePool,
      },
    };

    let approvalMeta: any;
    let requireApproval = false;

    const policyDecision = this.permissions.evaluate(toolUse.name);
    if (policyDecision === 'deny') {
      const message = 'Tool denied by policy';
      this.updateToolRecord(
        record.id,
        {
          state: 'DENIED',
          approval: buildApproval('deny', 'policy', message),
          error: message,
          isError: true,
        },
        'policy deny'
      );
      this.setBreakpoint('POST_TOOL');
      this.events.emitProgress({ channel: 'progress', type: 'tool:end', call: this.snapshotToolRecord(record.id) });
      return this.makeToolResult(toolUse.id, {
        ok: false,
        error: message,
        recommendations: ['检查模板或权限配置的 allow/deny 列表', '如需执行该工具，请调整权限模式或审批策略'],
      });
    }

    if (policyDecision === 'ask') {
      requireApproval = true;
      approvalMeta = { reason: 'Policy requires approval', tool: toolUse.name };
    }

    const decision = await this.hooks.runPreToolUse(
      { id: toolUse.id, name: toolUse.name, args: toolUse.input, agentId: this.agentId },
      context
    );

    if (decision) {
      if ('decision' in decision) {
        if (decision.decision === 'ask') {
          requireApproval = true;
          approvalMeta = { ...(approvalMeta || {}), ...(decision.meta || {}) };
        } else if (decision.decision === 'deny') {
          const message = decision.reason || 'Denied by hook';
          this.updateToolRecord(
            record.id,
            {
              state: 'DENIED',
              approval: buildApproval('deny', 'hook', message),
              error: message,
              isError: true,
            },
            'hook deny'
          );
          this.setBreakpoint('POST_TOOL');
          this.events.emitProgress({ channel: 'progress', type: 'tool:end', call: this.snapshotToolRecord(record.id) });
          return this.makeToolResult(toolUse.id, {
            ok: false,
            error: decision.toolResult || message,
            recommendations: ['根据 Hook 给出的原因调整输入或策略'],
          });
        }
      } else if ('result' in decision) {
        this.updateToolRecord(
          record.id,
          {
            state: 'COMPLETED',
            result: decision.result,
            completedAt: Date.now(),
          },
          'hook provided result'
        );
        this.events.emitMonitor({ channel: 'monitor', type: 'tool_executed', call: this.snapshotToolRecord(record.id) });
        this.setBreakpoint('POST_TOOL');
        this.events.emitProgress({ channel: 'progress', type: 'tool:end', call: this.snapshotToolRecord(record.id) });
        return this.makeToolResult(toolUse.id, { ok: true, data: decision.result });
      }
    }

    if (requireApproval) {
      this.setBreakpoint('AWAITING_APPROVAL');
      const decisionResult = await this.requestPermission(record.id, toolUse.name, toolUse.input, approvalMeta);
      if (decisionResult === 'deny') {
        const message = approvalMeta?.reason || 'Denied by approval';
        this.updateToolRecord(record.id, { state: 'DENIED', error: message, isError: true }, 'approval denied');
        this.setBreakpoint('POST_TOOL');
        this.events.emitProgress({ channel: 'progress', type: 'tool:end', call: this.snapshotToolRecord(record.id) });
        return this.makeToolResult(toolUse.id, { ok: false, error: message });
      }
      this.setBreakpoint('PRE_TOOL');
    }

    this.setBreakpoint('PRE_TOOL');
    this.updateToolRecord(record.id, { state: 'EXECUTING', startedAt: Date.now() }, 'execution start');
    this.setBreakpoint('TOOL_EXECUTING');

    const controller = new AbortController();
    this.toolControllers.set(toolUse.id, controller);
    context.signal = controller.signal;
    const timeoutId = setTimeout(() => controller.abort(), this.toolTimeoutMs);

    try {
      const output = await tool.exec(toolUse.input, context);

      // 检查 output 是否包含 ok 字段来判断工具是否成功
      const outputOk = output && typeof output === 'object' && 'ok' in output ? output.ok : true;
      let outcome: ToolOutcome = {
        id: toolUse.id,
        name: toolUse.name,
        ok: outputOk !== false,
        content: output
      };
      outcome = await this.hooks.runPostToolUse(outcome, context);

      if (toolUse.name === 'fs_read' && toolUse.input?.path) {
        await this.filePool.recordRead(toolUse.input.path);
      }
      if ((toolUse.name === 'fs_write' || toolUse.name === 'fs_edit' || toolUse.name === 'fs_multi_edit') && toolUse.input?.path) {
        await this.filePool.recordEdit(toolUse.input.path);
      }

      const success = outcome.ok !== false;
      const duration = Date.now() - (this.toolRecords.get(record.id)?.startedAt ?? Date.now());

      if (success) {
        this.updateToolRecord(
          record.id,
          {
            state: 'COMPLETED',
            result: outcome.content,
            durationMs: duration,
            completedAt: Date.now(),
          },
          'execution complete'
        );
        this.events.emitMonitor({ channel: 'monitor', type: 'tool_executed', call: this.snapshotToolRecord(record.id) });

        // 修复双嵌套问题：检查 outcome.content 是否已经是 {ok, data} 结构
        let resultData = outcome.content;
        if (outcome.content && typeof outcome.content === 'object' && 'ok' in outcome.content && 'data' in outcome.content) {
          // 如果工具返回的是 {ok: true, data: {...}} 结构，直接使用 data 部分
          resultData = (outcome.content as any).data;
        }

        return this.makeToolResult(toolUse.id, { ok: true, data: resultData });
      } else {
        const errorContent = outcome.content as any;
        const errorMessage = errorContent?.error || 'Tool returned failure';
        const errorType = errorContent?._validationError ? 'validation' :
                          errorContent?._thrownError ? 'runtime' : 'logical';
        const isRetryable = errorType !== 'validation';

        this.updateToolRecord(
          record.id,
          {
            state: 'FAILED',
            result: outcome.content,
            error: errorMessage,
            isError: true,
            durationMs: duration,
            completedAt: Date.now(),
          },
          'tool reported failure'
        );

        this.events.emitProgress({
          channel: 'progress',
          type: 'tool:error',
          call: this.snapshotToolRecord(record.id),
          error: errorMessage,
        });

        this.events.emitMonitor({
          channel: 'monitor',
          type: 'error',
          severity: 'warn',
          phase: 'tool',
          message: errorMessage,
          detail: { ...outcome.content, errorType, retryable: isRetryable },
        });

        const recommendations = errorContent?.recommendations || this.getErrorRecommendations(errorType, toolUse.name);

        return this.makeToolResult(toolUse.id, {
          ok: false,
          error: errorMessage,
          errorType,
          retryable: isRetryable,
          data: outcome.content,
          recommendations,
        });
      }
    } catch (error: any) {
      const isAbort = error?.name === 'AbortError';
      const message = isAbort ? 'Tool execution aborted' : error?.message || String(error);
      const errorType = isAbort ? 'aborted' : 'exception';

      this.updateToolRecord(
        record.id,
        { state: 'FAILED', error: message, isError: true },
        isAbort ? 'tool aborted' : 'execution failed'
      );

      this.events.emitProgress({
        channel: 'progress',
        type: 'tool:error',
        call: this.snapshotToolRecord(record.id),
        error: message,
      });

      this.events.emitMonitor({
        channel: 'monitor',
        type: 'error',
        severity: isAbort ? 'warn' : 'error',
        phase: 'tool',
        message,
        detail: { errorType, stack: error?.stack },
      });

      const recommendations = isAbort
        ? ['检查是否手动中断', '根据需要重新触发工具', '考虑调整超时时间']
        : this.getErrorRecommendations('runtime', toolUse.name);

      return this.makeToolResult(toolUse.id, {
        ok: false,
        error: message,
        errorType,
        retryable: !isAbort,
        recommendations,
      });
    } finally {
      clearTimeout(timeoutId);
      this.toolControllers.delete(toolUse.id);
      this.setBreakpoint('POST_TOOL');
      this.events.emitProgress({ channel: 'progress', type: 'tool:end', call: this.snapshotToolRecord(record.id) });
    }
  }

  private registerToolRecord(toolUse: { id: string; name: string; input: any }): ToolCallRecord {
    const now = Date.now();
    const record: ToolCallRecord = {
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
      state: 'PENDING',
      approval: { required: false },
      createdAt: now,
      updatedAt: now,
      auditTrail: [{ state: 'PENDING', timestamp: now }],
    };
    this.toolRecords.set(record.id, record);
    return record;
  }

  private updateToolRecord(id: string, update: Partial<ToolCallRecord>, auditNote?: string) {
    const record = this.toolRecords.get(id);
    if (!record) return;
    const now = Date.now();
    if (update.state && update.state !== record.state) {
      record.auditTrail.push({ state: update.state as ToolCallState, timestamp: now, note: auditNote });
    } else if (auditNote) {
      record.auditTrail.push({ state: record.state, timestamp: now, note: auditNote });
    }
    Object.assign(record, update, { updatedAt: now });
  }

  private snapshotToolRecord(id: string): ToolCallSnapshot {
    const record = this.toolRecords.get(id);
    if (!record) throw new Error(`Tool record not found: ${id}`);
    return {
      id: record.id,
      name: record.name,
      state: record.state,
      approval: record.approval,
      result: record.result,
      error: record.error,
      isError: record.isError,
      durationMs: record.durationMs,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      inputPreview: this.preview(record.input),
      auditTrail: [...record.auditTrail],
    };
  }

  private normalizeToolRecord(record: ToolCallRecord): ToolCallRecord {
    const timestamp = record.updatedAt ?? record.createdAt ?? Date.now();
    const auditTrail = record.auditTrail && record.auditTrail.length > 0
      ? record.auditTrail.map((entry) => ({ ...entry }))
      : [{ state: record.state, timestamp }];
    return { ...record, auditTrail };
  }

  private preview(value: any, limit = 200): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  private async requestPermission(id: string, _toolName: string, _args: any, meta?: any): Promise<'allow' | 'deny'> {
    const approval: ToolCallApproval = {
      required: true,
      decision: undefined,
      decidedAt: undefined,
      decidedBy: undefined,
      note: undefined,
      meta,
    };
    this.updateToolRecord(id, { state: 'APPROVAL_REQUIRED', approval }, 'awaiting approval');

    return new Promise((resolve) => {
      this.pendingPermissions.set(id, {
        resolve: (decision, note) => {
          this.updateToolRecord(
            id,
            {
              approval: buildApproval(decision, 'api', note),
              state: decision === 'allow' ? 'APPROVED' : 'DENIED',
              error: decision === 'deny' ? note : undefined,
              isError: decision === 'deny',
            },
            decision === 'allow' ? 'approval granted' : 'approval denied'
          );
          if (decision === 'allow') {
            this.setBreakpoint('PRE_TOOL');
          } else {
            this.setBreakpoint('POST_TOOL');
          }
          resolve(decision);
        },
      });

      this.events.emitControl({
        channel: 'control',
        type: 'permission_required',
        call: this.snapshotToolRecord(id),
        respond: async (decision, opts) => {
          await this.decide(id, decision, opts?.note);
        },
      });
      this.setState('PAUSED');
      this.setBreakpoint('AWAITING_APPROVAL');
    });
  }

  private findLastSfp(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === 'user') return i;
      if (msg.role === 'assistant' && !msg.content.some((block) => block.type === 'tool_use')) return i;
    }
    return -1;
  }

  private async appendSyntheticToolResults(note: string) {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const toolUses = last.content.filter((block) => block.type === 'tool_use') as any[];
    if (!toolUses.length) return;
    const resultIds = new Set<string>();
    for (const message of this.messages) {
      for (const block of message.content) {
        if (block.type === 'tool_result') resultIds.add((block as any).tool_use_id);
      }
    }
    const synthetic: ContentBlock[] = [];
    for (const tu of toolUses) {
      if (!resultIds.has(tu.id)) {
        const sealedResult = this.buildSealPayload('TOOL_RESULT_MISSING', tu.id, note);
        this.updateToolRecord(tu.id, { state: 'SEALED', error: sealedResult.message, isError: true }, 'sealed due to interrupt');
        synthetic.push(this.makeToolResult(tu.id, sealedResult.payload));
      }
    }
    if (synthetic.length) {
      this.messages.push({ role: 'user', content: synthetic });
      await this.persistMessages();
      await this.persistToolRecords();
    }
  }

  private async autoSealIncompleteCalls(
    note = 'Sealed due to crash while executing; verify potential side effects.'
  ): Promise<ToolCallSnapshot[]> {
    const sealedSnapshots: ToolCallSnapshot[] = [];
    const resultIds = new Set<string>();
    for (const message of this.messages) {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          resultIds.add((block as any).tool_use_id);
        }
      }
    }

    const synthetic: ContentBlock[] = [];
    for (const [id, record] of this.toolRecords) {
      if (['COMPLETED', 'FAILED', 'DENIED', 'SEALED'].includes(record.state)) continue;

      const sealedResult = this.buildSealPayload(record.state, id, note, record);
      this.updateToolRecord(
        id,
        { state: 'SEALED', error: sealedResult.message, isError: true, completedAt: Date.now() },
        'auto seal'
      );
      const snapshot = this.snapshotToolRecord(id);
      sealedSnapshots.push(snapshot);

      if (!resultIds.has(id)) {
        synthetic.push(this.makeToolResult(id, sealedResult.payload));
      }
    }

    if (synthetic.length > 0) {
      this.messages.push({ role: 'user', content: synthetic });
      await this.persistMessages();
    }
    await this.persistToolRecords();

    return sealedSnapshots;
  }

  private validateToolArgs(tool: ToolInstance, args: any): { ok: boolean; error?: string } {
    if (!tool.input_schema) {
      return { ok: true };
    }

    const key = JSON.stringify(tool.input_schema);
    let validator = this.validatorCache.get(key);
    if (!validator) {
      validator = this.ajv.compile(tool.input_schema);
      this.validatorCache.set(key, validator);
    }

    const valid = validator(args);
    if (!valid) {
      return {
        ok: false,
        error: this.ajv.errorsText(validator.errors, { separator: '\n' }),
      };
    }

    return { ok: true };
  }

  private makeToolResult(
    toolUseId: string,
    payload: {
      ok: boolean;
      data?: any;
      error?: string;
      errorType?: string;
      retryable?: boolean;
      note?: string;
      recommendations?: string[];
    }
  ): ContentBlock {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: {
        ok: payload.ok,
        data: payload.data,
        error: payload.error,
        errorType: payload.errorType,
        retryable: payload.retryable,
        note: payload.note,
        recommendations: payload.recommendations,
      },
      is_error: payload.ok ? false : true,
    };
  }

  private buildSealPayload(
    state: ToolCallState | string,
    toolUseId: string,
    fallbackNote: string,
    record?: ToolCallRecord
  ): { payload: { ok: false; error: string; data: any; recommendations: string[] }; message: string } {
    const baseMessage = (() => {
      switch (state) {
        case 'APPROVAL_REQUIRED':
          return '工具在等待审批时会话中断，系统已自动封口。';
        case 'APPROVED':
          return '工具已通过审批但尚未执行，系统已自动封口。';
        case 'EXECUTING':
          return '工具执行过程中会话中断，系统已自动封口。';
        case 'PENDING':
          return '工具刚准备执行时会话中断，系统已自动封口。';
        default:
          return fallbackNote;
      }
    })();

    const recommendations: string[] = (() => {
      switch (state) {
        case 'APPROVAL_REQUIRED':
          return ['确认审批是否仍然需要', '如需继续，请重新触发工具并完成审批'];
        case 'APPROVED':
          return ['确认工具输入是否仍然有效', '如需执行，请重新触发工具'];
        case 'EXECUTING':
          return ['检查工具可能产生的副作用', '确认外部系统状态后再重试'];
        case 'PENDING':
          return ['确认工具参数是否正确', '再次触发工具以继续流程'];
        default:
          return ['检查封口说明并决定是否重试工具'];
      }
    })();

    const detail = {
      status: state,
      startedAt: record?.startedAt,
      approval: record?.approval,
      toolId: toolUseId,
      note: baseMessage,
    };

    return {
      payload: {
        ok: false,
        error: baseMessage,
        data: detail,
        recommendations,
      },
      message: baseMessage,
    };
  }

  private wrapReminder(content: string, options?: ReminderOptions): string {
    if (options?.skipStandardEnding) return content;
    return [
      '<system-reminder>',
      content,
      '',
      'This is a system reminder. DO NOT respond to this message directly.',
      'DO NOT mention this reminder to the user.',
      'Continue with your current task.',
      '</system-reminder>',
    ].join('\n');
  }

  private getToolSchemas(): any[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));
  }

  private setState(state: AgentRuntimeState) {
    if (this.state === state) return;
    this.state = state;
    this.events.emitMonitor({ channel: 'monitor', type: 'state_changed', state });
  }

  private async persistMessages(): Promise<void> {
    await this.persistentStore.saveMessages(this.agentId, this.messages);
    await this.persistInfo();
    const snapshot = {
      agentId: this.agentId,
      messages: this.messages.map((message) => ({
        role: message.role,
        content: message.content.map((block) => ({ ...block })),
      })),
      lastBookmark: this.lastBookmark,
    };
    await this.hooks.runMessagesChanged(snapshot);
  }

  private async persistToolRecords(): Promise<void> {
    await this.persistentStore.saveToolCallRecords(this.agentId, Array.from(this.toolRecords.values()));
  }

  private async persistInfo(): Promise<void> {
    const metadata: AgentMetadata = {
      agentId: this.agentId,
      templateId: this.template.id,
      templateVersion: this.config.templateVersion || this.template.version,
      sandboxConfig: this.sandboxConfig,
      modelConfig: this.model.toConfig(),
      tools: this.toolDescriptors,
      exposeThinking: this.exposeThinking,
      permission: this.permission,
      todo: this.todoConfig,
      subagents: this.subagents,
      context: this.config.context,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      configVersion: CONFIG_VERSION,
      metadata: this.config.metadata,
      lineage: this.lineage,
      breakpoint: this.breakpoints.getCurrent(),
    };
    const info: AgentInfo = {
      agentId: this.agentId,
      templateId: this.template.id,
      createdAt: this.createdAt,
      lineage: metadata.lineage || [],
      configVersion: CONFIG_VERSION,
      messageCount: this.messages.length,
      lastSfpIndex: this.lastSfpIndex,
      lastBookmark: this.lastBookmark,
    } as AgentInfo;
    (info as any).metadata = metadata;
    await this.persistentStore.saveInfo(this.agentId, info);
  }

  private registerTodoTools() {
    const read = TodoRead;
    const write = TodoWrite;
    this.tools.set(read.name, read);
    this.tools.set(write.name, write);
    const descriptorNames = new Set(this.toolDescriptors.map((d) => d.name));
    if (!descriptorNames.has(read.name)) {
      const descriptor = read.toDescriptor();
      this.toolDescriptors.push(descriptor);
      this.toolDescriptorIndex.set(descriptor.name, descriptor);
    }
    if (!descriptorNames.has(write.name)) {
      const descriptor = write.toDescriptor();
      this.toolDescriptors.push(descriptor);
      this.toolDescriptorIndex.set(descriptor.name, descriptor);
    }
  }

  // ========== 工具说明书自动注入 ==========

  /**
   * 收集所有工具的使用说明
   */
  private collectToolPrompts(): Array<{ name: string; prompt: string }> {
    const prompts: Array<{ name: string; prompt: string }> = [];

    for (const tool of this.tools.values()) {
      if (tool.prompt) {
        const promptText = typeof tool.prompt === 'string' ? tool.prompt : undefined;
        if (promptText) {
          prompts.push({
            name: tool.name,
            prompt: promptText,
          });
        }
      }
    }

    return prompts;
  }

  /**
   * 渲染工具手册
   */
  private renderManual(prompts: Array<{ name: string; prompt: string }>): string {
    if (prompts.length === 0) return '';

    const sections = prompts.map(({ name, prompt }) => {
      return `**${name}**\n${prompt}`;
    });

    return `\n\n### Tools Manual\n\nThe following tools are available for your use. Please read their usage guidance carefully:\n\n${sections.join('\n\n')}`;
  }

  /**
   * 刷新工具手册（运行时工具变更时调用）
   */
  private refreshToolManual(): void {
    // 移除旧的 Tools Manual 部分
    const manualPattern = /\n\n### Tools Manual\n\n[\s\S]*$/;
    if (this.template.systemPrompt) {
      this.template.systemPrompt = this.template.systemPrompt.replace(manualPattern, '');
    }

    // 重新注入
    this.injectManualIntoSystemPrompt();
  }

  /**
   * 根据错误类型生成建议
   */
  private getErrorRecommendations(errorType: string, toolName: string): string[] {
    switch (errorType) {
      case 'validation':
        return [
          '检查工具参数是否符合schema要求',
          '确认所有必填参数已提供',
          '检查参数类型是否正确',
          '参考工具手册中的参数说明'
        ];
      case 'runtime':
        return [
          '检查系统资源是否可用',
          '确认文件/路径是否存在且有权限',
          '考虑添加错误处理逻辑',
          '可以重试该操作'
        ];
      case 'logical':
        if (toolName.startsWith('fs_')) {
          return [
            '确认文件内容是否符合预期',
            '检查文件是否被外部修改',
            '验证路径和模式是否正确',
            '可以先用 fs_read 确认文件状态'
          ];
        } else if (toolName.startsWith('bash_')) {
          return [
            '检查命令语法是否正确',
            '确认命令在沙箱环境中可执行',
            '查看stderr输出了解详细错误',
            '考虑调整超时时间或拆分命令'
          ];
        } else {
          return [
            '检查工具逻辑是否符合预期',
            '验证输入数据的完整性',
            '考虑重试或使用替代方案',
            '查看错误详情调整策略'
          ];
        }
      default:
        return [
          '查看错误信息调整输入',
          '考虑使用替代工具',
          '必要时寻求人工协助'
        ];
    }
  }

  /**
   * 将工具手册注入到系统提示中
   */
  private injectManualIntoSystemPrompt(): void {
    const prompts = this.collectToolPrompts();
    if (prompts.length === 0) return;

    const manual = this.renderManual(prompts);

    // 追加到模板的 systemPrompt
    if (this.template.systemPrompt) {
      this.template.systemPrompt += manual;
    } else {
      this.template.systemPrompt = manual;
    }

    // 发出 Monitor 事件
    this.events.emitMonitor({
      channel: 'monitor',
      type: 'tool_manual_updated',
      tools: prompts.map((p) => p.name),
      timestamp: Date.now(),
    });
  }

  /**
   * 将skills元数据注入到系统提示中
   * 参考openskills设计，使用<available_skills> XML格式
   */
  private async injectSkillsMetadataIntoSystemPrompt(): Promise<void> {
    logger.log('[Agent] injectSkillsMetadataIntoSystemPrompt: 开始执行');

    if (!this.skillsManager) {
      logger.log('[Agent] injectSkillsMetadataIntoSystemPrompt: skillsManager未定义，跳过');
      return;
    }

    try {
      logger.log('[Agent] injectSkillsMetadataIntoSystemPrompt: 正在获取skills元数据...');
      // 获取所有skills的元数据
      const skills = await this.skillsManager.getSkillsMetadata();
      logger.log(`[Agent] injectSkillsMetadataIntoSystemPrompt: 找到${skills.length}个skills`);

      if (skills.length === 0) {
        logger.log('[Agent] injectSkillsMetadataIntoSystemPrompt: skills列表为空，跳过');
        return;
      }

      // 导入XML生成器
      const { generateSkillsMetadataXml } = await import('./skills/xml-generator');

      // 生成XML格式的skills元数据
      const skillsXml = generateSkillsMetadataXml(skills);
      logger.log(`[Agent] injectSkillsMetadataIntoSystemPrompt: 生成XML完成，长度=${skillsXml.length}`);

      // 注入到模板的 systemPrompt
      if (this.template.systemPrompt) {
        this.template.systemPrompt += skillsXml;
      } else {
        this.template.systemPrompt = skillsXml;
      }

      // 发出 Monitor 事件
      this.events.emitMonitor({
        channel: 'monitor',
        type: 'skills_metadata_updated',
        skills: skills.map(s => s.name),
        timestamp: Date.now(),
      });

      logger.log(`[Agent] ✓ Injected ${skills.length} skill(s) metadata into system prompt`);

      // 输出完整的system prompt以便检查
      logger.log(`[Agent] ========== Complete System Prompt ==========`);
      logger.log(this.template.systemPrompt);
      logger.log(`[Agent] ========== End of System Prompt ==========`);
    } catch (error: any) {
      logger.error('[Agent] Failed to inject skills metadata:', error?.message || error);
      logger.error('[Agent] Error stack:', error?.stack);
    }
  }

  /**
   * 刷新skills元数据（运行时skills变更时调用）
   * 由于支持热更新，可在执行过程中调用此方法
   */
  private async refreshSkillsMetadata(): Promise<void> {
    if (!this.skillsManager) {
      return;
    }

    // 移除旧的 <skills_system> 部分
    const skillsSystemPattern = /<skills_system[\s\S]*?<\/skills_system>\s*/;
    if (this.template.systemPrompt) {
      this.template.systemPrompt = this.template.systemPrompt.replace(skillsSystemPattern, '');
    }

    // 重新注入
    await this.injectSkillsMetadataIntoSystemPrompt();
  }

  private enqueueMessage(message: Message, kind: 'user' | 'reminder'): void {
    this.messages.push(message);
    if (kind === 'user') {
      this.lastSfpIndex = this.messages.length - 1;
      this.stepCount++;
    }
  }

  private handleExternalFileChange(path: string, mtime: number) {
    const relPath = this.relativePath(path);
    this.events.emitMonitor({ channel: 'monitor', type: 'file_changed', path: relPath, mtime });
    const reminder = `检测到外部修改：${relPath}。请重新使用 fs_read 确认文件内容，并在必要时向用户同步。`;
    this.remind(reminder, { category: 'file', priority: 'medium' });
  }

  private relativePath(absPath: string): string {
    const path = require('path');
    return path.relative(this.sandbox.workDir || process.cwd(), this.sandbox.fs.resolve(absPath));
  }

  private static generateAgentId(): string {
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const now = Date.now();
    const timePart = encodeUlid(now, 10, chars);
    const random = Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `agt:${timePart}${random}`;
  }
}

function ensureModelFactory(factory?: ModelFactory): ModelFactory {
  if (factory) return factory;
  return (config: ModelConfig) => {
    if (config.provider === 'anthropic') {
      if (!config.apiKey) {
        throw new Error('Anthropic provider requires apiKey');
      }
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        maxOutputTokens: config.maxTokens,
        temperature: config.temperature,
      });
    }
    if (config.provider === 'openrouter') {
      if (!config.apiKey) {
        throw new Error('OpenRouter provider requires apiKey');
      }
      if (!config.model) {
        throw new Error('OpenRouter provider requires model');
      }
      return new OpenRouterProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        maxOutputTokens: config.maxTokens,
        temperature: config.temperature,
      });
    }
    throw new Error(`Model factory not provided for provider: ${config.provider}`);
  };
}

function resolveTools(
  config: AgentConfig,
  template: AgentTemplateDefinition,
  registry: ToolRegistry,
  templateRegistry: AgentTemplateRegistry
): {
  instances: ToolInstance[];
  descriptors: ToolDescriptor[];
} {
  const requested = config.tools ?? (template.tools === '*' ? registry.list() : template.tools || []);
  const instances: ToolInstance[] = [];
  const descriptors: ToolDescriptor[] = [];
  for (const id of requested) {
    const creationConfig = buildToolConfig(id, template, templateRegistry);
    const tool = registry.create(id, creationConfig);
    instances.push(tool);
    descriptors.push(tool.toDescriptor());
  }
  return { instances, descriptors };
}

function buildToolConfig(id: string, template: AgentTemplateDefinition, templateRegistry: AgentTemplateRegistry): Record<string, any> | undefined {
  if (id === 'task_run') {
    const allowed = template.runtime?.subagents?.templates;
    const templates = allowed && allowed.length > 0 ? allowed.map((tplId) => templateRegistry.get(tplId)) : templateRegistry.list();
    return { templates };
  }
  return undefined;
}

function encodeUlid(time: number, length: number, chars: string): string {
  let remaining = time;
  const encoded = Array<string>(length);
  for (let i = length - 1; i >= 0; i--) {
    const mod = remaining % 32;
    encoded[i] = chars.charAt(mod);
    remaining = Math.floor(remaining / 32);
  }
  return encoded.join('');
}

function buildApproval(decision: 'allow' | 'deny', by: string, note?: string): ToolCallApproval {
  return {
    required: true,
    decision,
    decidedBy: by,
    decidedAt: Date.now(),
    note,
  };
}
