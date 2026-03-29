# API Reference

This document provides a complete API reference for KODE SDK v2.7.0.

---

## Agent

The core class for creating and managing AI agents.

### Static Methods

#### `Agent.create(config, deps)`

Creates a new Agent instance.

```typescript
static async create(config: AgentConfig, deps: AgentDependencies): Promise<Agent>
```

**Parameters:**
- `config: AgentConfig` - Agent configuration
- `deps: AgentDependencies` - Required dependencies

**Example:**
```typescript
const agent = await Agent.create({
  templateId: 'assistant',
  modelConfig: {
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  sandbox: { kind: 'local', workDir: './workspace' },
}, deps);
```

#### `Agent.resume(agentId, config, deps, opts?)`

Resumes an existing Agent from storage.

```typescript
static async resume(
  agentId: string,
  config: AgentConfig,
  deps: AgentDependencies,
  opts?: { autoRun?: boolean; strategy?: ResumeStrategy }
): Promise<Agent>
```

**Parameters:**
- `agentId: string` - Agent ID to resume
- `config: AgentConfig` - Agent configuration
- `deps: AgentDependencies` - Required dependencies
- `opts.autoRun?: boolean` - Continue processing after resume (default: false)
- `opts.strategy?: ResumeStrategy` - `'crash'` (auto-seal) or `'manual'`

#### `Agent.resumeFromStore(agentId, deps, opts?)`

Resumes an Agent using metadata from store (recommended).

```typescript
static async resumeFromStore(
  agentId: string,
  deps: AgentDependencies,
  opts?: { overrides?: Partial<AgentConfig>; autoRun?: boolean; strategy?: ResumeStrategy }
): Promise<Agent>
```

### Instance Methods

#### `agent.send(message, options?)`

Sends a message and returns the text response.

```typescript
async send(message: string | ContentBlock[], options?: SendOptions): Promise<string>
```

#### `agent.chat(input, opts?)`

Sends a message and returns structured result with status.

```typescript
async chat(input: string | ContentBlock[], opts?: StreamOptions): Promise<CompleteResult>
```

**Returns:**
```typescript
interface CompleteResult {
  status: 'ok' | 'paused';
  text?: string;
  last?: Bookmark;
  permissionIds?: string[];
}
```

#### `agent.complete(input, opts?)`

Alias for `chat()`.

#### `agent.decide(permissionId, decision, note?)`

Responds to a permission request.

```typescript
async decide(permissionId: string, decision: 'allow' | 'deny', note?: string): Promise<void>
```

#### `agent.interrupt(opts?)`

Interrupts the current processing.

```typescript
async interrupt(opts?: { note?: string }): Promise<void>
```

#### `agent.snapshot(label?)`

Creates a snapshot at the current Safe-Fork-Point.

```typescript
async snapshot(label?: string): Promise<SnapshotId>
```

#### `agent.fork(sel?)`

Creates a forked Agent from a snapshot.

```typescript
async fork(sel?: SnapshotId | { at?: string }): Promise<Agent>
```

#### `agent.delegateTask(config)`

Create and run a delegated sub-Agent task (commonly used by `task_run`).

```typescript
async delegateTask(config: {
  templateId: string;
  prompt: string;
  model?: string | { provider: string; model: string } | ModelProvider;
  tools?: string[];
}): Promise<CompleteResult>
```

**Model resolution rules:**
- `model` omitted: reuse parent `ModelProvider` instance.
- `model` is `string`: keep parent provider type and override only model ID (for custom providers, this path requires `modelFactory`).
- `model` is `{ provider, model }`: explicitly choose provider + model (for custom providers, this path usually requires `modelFactory` when provider differs).
- `model` is `ModelProvider`: use the provided instance directly.

#### `agent.status()`

Returns current Agent status.

```typescript
async status(): Promise<AgentStatus>
```

**Returns:**
```typescript
interface AgentStatus {
  agentId: string;
  state: AgentRuntimeState;  // 'READY' | 'WORKING' | 'PAUSED'
  stepCount: number;
  lastSfpIndex: number;
  lastBookmark?: Bookmark;
  cursor: number;
  breakpoint: BreakpointState;
}
```

#### `agent.info()`

Returns Agent metadata.

```typescript
async info(): Promise<AgentInfo>
```

#### `agent.setTodos(todos)`

Sets the entire Todo list.

```typescript
async setTodos(todos: TodoInput[]): Promise<void>
```

#### `agent.updateTodo(todo)`

Updates a single Todo item.

```typescript
async updateTodo(todo: TodoInput): Promise<void>
```

#### `agent.deleteTodo(id)`

Deletes a Todo item.

```typescript
async deleteTodo(id: string): Promise<void>
```

#### `agent.on(event, handler)`

Subscribes to Control and Monitor events. Returns an unsubscribe function.

```typescript
on<T extends ControlEvent['type'] | MonitorEvent['type']>(
  event: T,
  handler: (evt: any) => void
): () => void
```

**Supported events:**
- Control: `'permission_required'`, `'permission_decided'`
- Monitor: `'state_changed'`, `'step_complete'`, `'error'`, `'token_usage'`, `'tool_executed'`, `'agent_resumed'`, `'todo_changed'`, `'file_changed'`

**Example:**
```typescript
// Monitor events
const unsubscribe = agent.on('tool_executed', (event) => {
  console.log(`Tool ${event.call.name} executed`);
});

agent.on('error', (event) => {
  console.error('Error:', event.error);
});

// Control events
agent.on('permission_required', (event) => {
  console.log(`Permission needed for: ${event.call.name}`);
});

// Unsubscribe when done
unsubscribe();
```

> **Note:** For Progress events (`text_chunk`, `tool:start`, `done`, etc.), use `agent.subscribe(['progress'])` instead.

---

## AgentConfig

Configuration for creating an Agent.

```typescript
interface AgentConfig {
  agentId?: string;                    // Auto-generated if not provided
  templateId: string;                  // Required: template ID
  templateVersion?: string;            // Optional: template version
  model?: ModelProvider;               // Direct model provider
  modelConfig?: ModelConfig;           // Or model configuration
  sandbox?: Sandbox | SandboxConfig;   // Sandbox instance or config
  tools?: string[];                    // Tool names to enable
  exposeThinking?: boolean;            // Emit thinking events
  retainThinking?: boolean;            // Keep thinking in message history
  multimodalContinuation?: 'history';  // Preserve multimodal context across turns
  multimodalRetention?: { keepRecent?: number };  // Keep recent multimodal items
  overrides?: {
    permission?: PermissionConfig;
    todo?: TodoConfig;
    subagents?: SubAgentConfig;
    hooks?: Hooks;
  };
  context?: ContextManagerOptions;
  metadata?: Record<string, any>;
}
```

---

## AgentDependencies

Required dependencies for Agent creation.

```typescript
interface AgentDependencies {
  store: Store;                        // Storage backend
  templateRegistry: AgentTemplateRegistry;
  sandboxFactory: SandboxFactory;
  toolRegistry: ToolRegistry;
  modelFactory?: ModelFactory;         // Optional factory for model creation
  skillsManager?: SkillsManager;       // Optional skills manager
}
```

---

## Store

Interface for Agent data persistence.

### Core Methods

```typescript
interface Store {
  // Messages
  saveMessages(agentId: string, messages: Message[]): Promise<void>;
  loadMessages(agentId: string): Promise<Message[]>;

  // Tool Records
  saveToolCallRecords(agentId: string, records: ToolCallRecord[]): Promise<void>;
  loadToolCallRecords(agentId: string): Promise<ToolCallRecord[]>;

  // Todos
  saveTodos(agentId: string, snapshot: TodoSnapshot): Promise<void>;
  loadTodos(agentId: string): Promise<TodoSnapshot | undefined>;

  // Events
  appendEvent(agentId: string, timeline: Timeline): Promise<void>;
  readEvents(agentId: string, opts?: { since?: Bookmark; channel?: AgentChannel }): AsyncIterable<Timeline>;

  // Snapshots
  saveSnapshot(agentId: string, snapshot: Snapshot): Promise<void>;
  loadSnapshot(agentId: string, snapshotId: string): Promise<Snapshot | undefined>;
  listSnapshots(agentId: string): Promise<Snapshot[]>;

  // Metadata
  saveInfo(agentId: string, info: AgentInfo): Promise<void>;
  loadInfo(agentId: string): Promise<AgentInfo | undefined>;

  // Lifecycle
  exists(agentId: string): Promise<boolean>;
  delete(agentId: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

### Store Implementations

| Class | Description |
|-------|-------------|
| `JSONStore` | File-based storage (default) |
| `SqliteStore` | SQLite database storage |
| `PostgresStore` | PostgreSQL database storage |

### Factory Function

```typescript
import { createExtendedStore } from '@shareai-lab/kode-sdk';

// SQLite
const store = await createExtendedStore({
  type: 'sqlite',
  dbPath: './data/agents.db',
  fileStoreBaseDir: './data/store',
});

// PostgreSQL
const store = await createExtendedStore({
  type: 'postgres',
  connection: {
    host: 'localhost',
    port: 5432,
    database: 'kode_agents',
    user: 'kode',
    password: 'password',
  },
  fileStoreBaseDir: './data/store',
});
```

---

## QueryableStore

Extended Store interface with query capabilities.

```typescript
interface QueryableStore extends Store {
  querySessions(filters: SessionFilters): Promise<SessionInfo[]>;
  queryMessages(filters: MessageFilters): Promise<Message[]>;
  queryToolCalls(filters: ToolCallFilters): Promise<ToolCallRecord[]>;
  aggregateStats(agentId: string): Promise<AgentStats>;
}
```

### SessionFilters

```typescript
interface SessionFilters {
  agentId?: string;
  templateId?: string;
  userId?: string;
  startDate?: number;      // Unix timestamp (ms)
  endDate?: number;
  limit?: number;
  offset?: number;
  sortBy?: 'created_at' | 'updated_at' | 'message_count';
  sortOrder?: 'asc' | 'desc';
}
```

### MessageFilters

```typescript
interface MessageFilters {
  agentId?: string;
  role?: 'user' | 'assistant' | 'system';
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}
```

### ToolCallFilters

```typescript
interface ToolCallFilters {
  agentId?: string;
  toolName?: string;
  state?: ToolCallState;
  startDate?: number;
  endDate?: number;
  limit?: number;
  offset?: number;
}
```

---

## ExtendedStore

Store with advanced features.

```typescript
interface ExtendedStore extends QueryableStore {
  healthCheck(): Promise<StoreHealthStatus>;
  checkConsistency(agentId: string): Promise<ConsistencyCheckResult>;
  getMetrics(): Promise<StoreMetrics>;
  acquireAgentLock(agentId: string, timeoutMs?: number): Promise<LockReleaseFn>;
  batchFork(agentId: string, count: number): Promise<string[]>;
  close(): Promise<void>;
}
```

---

## ToolRegistry

Registry for tool factories.

```typescript
class ToolRegistry {
  register(id: string, factory: ToolFactory): void;
  has(id: string): boolean;
  create(id: string, config?: Record<string, any>): ToolInstance;
  list(): string[];
}
```

### ToolInstance

```typescript
interface ToolInstance {
  name: string;
  description: string;
  input_schema: any;                   // JSON Schema
  hooks?: Hooks;
  prompt?: string | ((ctx: ToolContext) => string | Promise<string>);
  exec(args: any, ctx: ToolContext): Promise<any>;
  toDescriptor(): ToolDescriptor;
}
```

### defineTool()

Simplified API for creating tools.

```typescript
import { defineTool } from '@shareai-lab/kode-sdk';

const myTool = defineTool({
  name: 'my_tool',
  description: 'Does something useful',
  params: {
    input: { type: 'string', description: 'Input value' },
    count: { type: 'number', required: false, default: 1 },
  },
  attributes: {
    readonly: true,
    noEffect: true,
  },
  async exec(args, ctx) {
    ctx.emit('custom_event', { data: 'value' });
    return { result: args.input };
  },
});
```

---

## AgentTemplateRegistry

Registry for Agent templates.

```typescript
class AgentTemplateRegistry {
  register(template: AgentTemplateDefinition): void;
  bulkRegister(templates: AgentTemplateDefinition[]): void;
  has(id: string): boolean;
  get(id: string): AgentTemplateDefinition;
  list(): AgentTemplateDefinition[];
}
```

### AgentTemplateDefinition

```typescript
interface AgentTemplateDefinition {
  id: string;                          // Required: unique identifier
  name?: string;                       // Display name
  desc?: string;                       // Description
  version?: string;                    // Template version
  systemPrompt: string;                // Required: system prompt
  model?: string;                      // Default model
  sandbox?: Record<string, any>;       // Sandbox configuration
  tools?: '*' | string[];              // '*' for all, or specific tools
  permission?: PermissionConfig;       // Permission configuration
  runtime?: TemplateRuntimeConfig;     // Runtime options
  hooks?: Hooks;                       // Hook functions
  metadata?: Record<string, any>;      // Custom metadata
}
```

---

## AgentPool

Manages multiple Agent instances.

```typescript
class AgentPool {
  constructor(opts: AgentPoolOptions);

  async create(agentId: string, config: AgentConfig): Promise<Agent>;
  get(agentId: string): Agent | undefined;
  list(opts?: { prefix?: string }): string[];
  async status(agentId: string): Promise<AgentStatus | undefined>;
  async fork(agentId: string, snapshotSel?: SnapshotId | { at?: string }): Promise<Agent>;
  async resume(agentId: string, config: AgentConfig, opts?: { autoRun?: boolean; strategy?: ResumeStrategy }): Promise<Agent>;
  async delete(agentId: string): Promise<void>;
}
```

---

## Room

Multi-Agent collaboration space.

```typescript
class Room {
  constructor(pool: AgentPool);

  join(name: string, agentId: string): void;
  leave(name: string): void;
  async say(from: string, text: string): Promise<void>;
  getMembers(): RoomMember[];
}
```

**Example:**
```typescript
const pool = new AgentPool({ dependencies: deps });
const room = new Room(pool);

// Create and join agents
const agent1 = await pool.create('agent-1', config);
const agent2 = await pool.create('agent-2', config);

room.join('Alice', 'agent-1');
room.join('Bob', 'agent-2');

// Broadcast message
await room.say('Alice', 'Hello everyone!');

// Directed message
await room.say('Alice', '@Bob What do you think?');
```

---

## Providers

### AnthropicProvider

```typescript
import { AnthropicProvider } from '@shareai-lab/kode-sdk';

const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-20250514',
  process.env.ANTHROPIC_BASE_URL, // optional
  process.env.HTTPS_PROXY, // optional
  {
    thinking: { enabled: true, budgetTokens: 10000 },
  }
);
```

### OpenAIProvider

```typescript
import { OpenAIProvider } from '@shareai-lab/kode-sdk';

const provider = new OpenAIProvider(
  process.env.OPENAI_API_KEY!,
  process.env.OPENAI_MODEL_ID ?? 'gpt-4o',
  process.env.OPENAI_BASE_URL, // optional
  process.env.HTTPS_PROXY, // optional
  {
    api: 'responses',
    responses: { reasoning: { effort: 'medium' } },
  }
);
```

### GeminiProvider

```typescript
import { GeminiProvider } from '@shareai-lab/kode-sdk';

const provider = new GeminiProvider(
  process.env.GOOGLE_API_KEY!,
  process.env.GEMINI_MODEL_ID ?? 'gemini-2.0-flash',
  process.env.GEMINI_BASE_URL, // optional
  process.env.HTTPS_PROXY, // optional
  {
    thinking: { level: 'medium' },
  }
);
```

---

## Built-in Tools

| Tool | Description |
|------|-------------|
| `fs_read` | Read file content |
| `fs_write` | Create/overwrite file |
| `fs_edit` | Edit file with replacements |
| `fs_glob` | Match files with glob patterns |
| `fs_grep` | Search text/regex in files |
| `fs_multi_edit` | Batch edit multiple files |
| `bash_run` | Execute shell commands |
| `bash_logs` | Read background command output |
| `bash_kill` | Terminate background commands |
| `todo_read` | Read Todo list |
| `todo_write` | Write Todo list |
| `task_run` | Dispatch sub-Agent |
| `skills` | Load skills |

### Registering Built-in Tools

```typescript
import { builtin, ToolRegistry } from '@shareai-lab/kode-sdk';

const registry = new ToolRegistry();

// builtin is an object with methods that return ToolInstance[]
for (const tool of [...builtin.fs(), ...builtin.bash(), ...builtin.todo()]) {
  registry.register(tool.name, () => tool);
}

// Or register specific tool groups
builtin.fs().forEach(tool => registry.register(tool.name, () => tool));
builtin.bash().forEach(tool => registry.register(tool.name, () => tool));
builtin.todo().forEach(tool => registry.register(tool.name, () => tool));
```

**Available builtin groups:**
- `builtin.fs()` - File system tools: `fs_read`, `fs_write`, `fs_edit`, `fs_glob`, `fs_grep`, `fs_multi_edit`
- `builtin.bash()` - Shell tools: `bash_run`, `bash_logs`, `bash_kill`
- `builtin.todo()` - Todo tools: `todo_read`, `todo_write`
- `builtin.task(templates)` - Sub-agent tool: `task_run` (requires templates)

---

## SkillsManager

Manages skills at Agent runtime.

```typescript
class SkillsManager {
  constructor(skillsDir: string, whitelist?: string[]);

  async getSkillsMetadata(): Promise<SkillMetadata[]>;
  async loadSkillContent(skillName: string): Promise<SkillContent | null>;
}
```

---

## Utility Functions

### generateAgentId()

Generates a unique Agent ID.

```typescript
import { generateAgentId } from '@shareai-lab/kode-sdk';

const agentId = generateAgentId(); // e.g., 'agt-abc123xyz'
```

---

## E2BSandbox

Cloud sandbox powered by [E2B](https://e2b.dev) for isolated code execution.

### Constructor

```typescript
new E2BSandbox(options?: E2BSandboxOptions)
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `init()` | `async init(): Promise<void>` | Initialize (create or connect) sandbox |
| `exec(cmd, opts?)` | `async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<SandboxExecResult>` | Execute a command |
| `dispose()` | `async dispose(): Promise<void>` | Kill sandbox and cleanup |
| `getSandboxId()` | `getSandboxId(): string` | Get sandbox ID for persistence |
| `getHostUrl(port)` | `getHostUrl(port: number): string` | Get accessible URL for a port |
| `setTimeout(ms)` | `async setTimeout(timeoutMs: number): Promise<void>` | Extend sandbox lifetime |
| `isRunning()` | `async isRunning(): Promise<boolean>` | Check if sandbox is alive |
| `watchFiles(paths, listener)` | `async watchFiles(...): Promise<string>` | Watch file changes |
| `unwatchFiles(id)` | `unwatchFiles(id: string): void` | Stop watching |
| `getE2BInstance()` | `getE2BInstance(): E2BSdk` | Access underlying E2B SDK |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'e2b'` | Sandbox type identifier |
| `workDir` | `string` | Working directory path |
| `fs` | `SandboxFS` | File system operations |

---

## OpenSandbox

Self-hosted sandbox powered by [OpenSandbox](https://www.npmjs.com/package/@alibaba-group/opensandbox) for isolated code execution.

### Constructor

```typescript
new OpenSandbox(options: OpenSandboxOptions)
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `init()` | `async init(): Promise<void>` | Initialize (create or connect) sandbox |
| `exec(cmd, opts?)` | `async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<SandboxExecResult>` | Execute a command |
| `dispose()` | `async dispose(): Promise<void>` | Dispose sandbox by lifecycle policy |
| `getSandboxId()` | `getSandboxId(): string \| undefined` | Get sandbox ID for persistence |
| `isRunning()` | `async isRunning(): Promise<boolean>` | Check if sandbox is alive |
| `watchFiles(paths, listener)` | `async watchFiles(...): Promise<string>` | Watch file changes (polling fallback supported) |
| `unwatchFiles(id)` | `unwatchFiles(id: string): void` | Stop watching |
| `getOpenSandbox()` | `getOpenSandbox(): OpenSandboxClient` | Access underlying OpenSandbox client |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'opensandbox'` | Sandbox type identifier |
| `workDir` | `string` | Working directory path |
| `fs` | `SandboxFS` | File system operations |

---

## E2BTemplateBuilder

Static utility for building custom E2B sandbox templates.

### Static Methods

#### `E2BTemplateBuilder.build(config, opts?)`

```typescript
static async build(
  config: E2BTemplateConfig,
  opts?: { apiKey?: string; onLog?: (log: string) => void }
): Promise<{ templateId: string; alias: string }>
```

#### `E2BTemplateBuilder.exists(alias, opts?)`

```typescript
static async exists(alias: string, opts?: { apiKey?: string }): Promise<boolean>
```

---

## References

- [Types Reference](./types.md)
- [Events Reference](./events-reference.md)
- [Guides](../guides/events.md)
- [E2B Sandbox Guide](../guides/e2b-sandbox.md)
- [OpenSandbox Guide](../guides/opensandbox-sandbox.md)
