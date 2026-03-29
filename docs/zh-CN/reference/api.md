# API 参考

本文档提供 KODE SDK v2.7.0 的完整 API 参考。

---

## Agent

创建和管理 AI Agent 的核心类。

### 静态方法

#### `Agent.create(config, deps)`

创建新的 Agent 实例。

```typescript
static async create(config: AgentConfig, deps: AgentDependencies): Promise<Agent>
```

**参数：**
- `config: AgentConfig` - Agent 配置
- `deps: AgentDependencies` - 必需的依赖项

**示例：**
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

从存储恢复已有的 Agent。

```typescript
static async resume(
  agentId: string,
  config: AgentConfig,
  deps: AgentDependencies,
  opts?: { autoRun?: boolean; strategy?: ResumeStrategy }
): Promise<Agent>
```

**参数：**
- `agentId: string` - 要恢复的 Agent ID
- `config: AgentConfig` - Agent 配置
- `deps: AgentDependencies` - 必需的依赖项
- `opts.autoRun?: boolean` - 恢复后继续处理（默认：false）
- `opts.strategy?: ResumeStrategy` - `'crash'`（自动封口）或 `'manual'`

#### `Agent.resumeFromStore(agentId, deps, opts?)`

使用存储中的元数据恢复 Agent（推荐）。

```typescript
static async resumeFromStore(
  agentId: string,
  deps: AgentDependencies,
  opts?: { overrides?: Partial<AgentConfig>; autoRun?: boolean; strategy?: ResumeStrategy }
): Promise<Agent>
```

### 实例方法

#### `agent.send(message, options?)`

发送消息并返回文本响应。

```typescript
async send(message: string | ContentBlock[], options?: SendOptions): Promise<string>
```

#### `agent.chat(input, opts?)`

发送消息并返回带状态的结构化结果。

```typescript
async chat(input: string | ContentBlock[], opts?: StreamOptions): Promise<CompleteResult>
```

**返回：**
```typescript
interface CompleteResult {
  status: 'ok' | 'paused';
  text?: string;
  last?: Bookmark;
  permissionIds?: string[];
}
```

#### `agent.complete(input, opts?)`

`chat()` 的别名。

#### `agent.decide(permissionId, decision, note?)`

响应权限请求。

```typescript
async decide(permissionId: string, decision: 'allow' | 'deny', note?: string): Promise<void>
```

#### `agent.interrupt(opts?)`

中断当前处理。

```typescript
async interrupt(opts?: { note?: string }): Promise<void>
```

#### `agent.snapshot(label?)`

在当前 Safe-Fork-Point 创建快照。

```typescript
async snapshot(label?: string): Promise<SnapshotId>
```

#### `agent.fork(sel?)`

从快照创建分叉的 Agent。

```typescript
async fork(sel?: SnapshotId | { at?: string }): Promise<Agent>
```

#### `agent.delegateTask(config)`

创建并执行被委派的子 Agent 任务（`task_run` 的核心调用路径）。

```typescript
async delegateTask(config: {
  templateId: string;
  prompt: string;
  model?: string | { provider: string; model: string } | ModelProvider;
  tools?: string[];
}): Promise<CompleteResult>
```

**模型解析规则：**
- 不传 `model`：复用父 `ModelProvider` 实例。
- `model` 为 `string`：保持父 provider 类型，仅覆盖模型 ID（自定义 provider 走该路径时需要 `modelFactory`）。
- `model` 为 `{ provider, model }`：显式指定 provider + model（provider 与父模型不同时，自定义 provider 通常需要 `modelFactory`）。
- `model` 为 `ModelProvider`：直接使用传入实例。

#### `agent.status()`

返回当前 Agent 状态。

```typescript
async status(): Promise<AgentStatus>
```

**返回：**
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

返回 Agent 元数据。

```typescript
async info(): Promise<AgentInfo>
```

#### `agent.setTodos(todos)`

设置完整的 Todo 列表。

```typescript
async setTodos(todos: TodoInput[]): Promise<void>
```

#### `agent.updateTodo(todo)`

更新单个 Todo 项。

```typescript
async updateTodo(todo: TodoInput): Promise<void>
```

#### `agent.deleteTodo(id)`

删除 Todo 项。

```typescript
async deleteTodo(id: string): Promise<void>
```

#### `agent.on(event, handler)`

订阅 Control 和 Monitor 事件。返回取消订阅函数。

```typescript
on<T extends ControlEvent['type'] | MonitorEvent['type']>(
  event: T,
  handler: (evt: any) => void
): () => void
```

**支持的事件：**
- Control: `'permission_required'`, `'permission_decided'`
- Monitor: `'state_changed'`, `'step_complete'`, `'error'`, `'token_usage'`, `'tool_executed'`, `'agent_resumed'`, `'todo_changed'`, `'file_changed'`

**示例：**
```typescript
// Monitor 事件
const unsubscribe = agent.on('tool_executed', (event) => {
  console.log(`工具 ${event.call.name} 已执行`);
});

agent.on('error', (event) => {
  console.error('错误:', event.error);
});

// Control 事件
agent.on('permission_required', (event) => {
  console.log(`需要权限: ${event.call.name}`);
});

// 完成后取消订阅
unsubscribe();
```

> **注意：** 对于 Progress 事件（`text_chunk`、`tool:start`、`done` 等），请使用 `agent.subscribe(['progress'])`。

---

## AgentConfig

创建 Agent 的配置。

```typescript
interface AgentConfig {
  agentId?: string;                    // 不提供则自动生成
  templateId: string;                  // 必需：模板 ID
  templateVersion?: string;            // 可选：模板版本
  model?: ModelProvider;               // 直接提供模型实例
  modelConfig?: ModelConfig;           // 或模型配置
  sandbox?: Sandbox | SandboxConfig;   // 沙箱实例或配置
  tools?: string[];                    // 要启用的工具名称
  exposeThinking?: boolean;            // 发送思考事件
  retainThinking?: boolean;            // 在消息历史中保留思考
  multimodalContinuation?: 'history';  // 跨轮保留多模态上下文
  multimodalRetention?: { keepRecent?: number };  // 保留最近 N 条多模态内容
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

创建 Agent 所需的依赖项。

```typescript
interface AgentDependencies {
  store: Store;                        // 存储后端
  templateRegistry: AgentTemplateRegistry;
  sandboxFactory: SandboxFactory;
  toolRegistry: ToolRegistry;
  modelFactory?: ModelFactory;         // 可选的模型创建工厂
  skillsManager?: SkillsManager;       // 可选的技能管理器
}
```

---

## Store

Agent 数据持久化接口。

### 核心方法

```typescript
interface Store {
  // 消息
  saveMessages(agentId: string, messages: Message[]): Promise<void>;
  loadMessages(agentId: string): Promise<Message[]>;

  // 工具记录
  saveToolCallRecords(agentId: string, records: ToolCallRecord[]): Promise<void>;
  loadToolCallRecords(agentId: string): Promise<ToolCallRecord[]>;

  // Todo
  saveTodos(agentId: string, snapshot: TodoSnapshot): Promise<void>;
  loadTodos(agentId: string): Promise<TodoSnapshot | undefined>;

  // 事件
  appendEvent(agentId: string, timeline: Timeline): Promise<void>;
  readEvents(agentId: string, opts?: { since?: Bookmark; channel?: AgentChannel }): AsyncIterable<Timeline>;

  // 快照
  saveSnapshot(agentId: string, snapshot: Snapshot): Promise<void>;
  loadSnapshot(agentId: string, snapshotId: string): Promise<Snapshot | undefined>;
  listSnapshots(agentId: string): Promise<Snapshot[]>;

  // 元数据
  saveInfo(agentId: string, info: AgentInfo): Promise<void>;
  loadInfo(agentId: string): Promise<AgentInfo | undefined>;

  // 生命周期
  exists(agentId: string): Promise<boolean>;
  delete(agentId: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

### Store 实现

| 类 | 说明 |
|---|------|
| `JSONStore` | 基于文件的存储（默认）|
| `SqliteStore` | SQLite 数据库存储 |
| `PostgresStore` | PostgreSQL 数据库存储 |

### 工厂函数

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

带查询能力的扩展 Store 接口。

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
  startDate?: number;      // Unix 时间戳（毫秒）
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

带高级功能的 Store。

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

工具工厂注册表。

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

创建工具的简化 API。

```typescript
import { defineTool } from '@shareai-lab/kode-sdk';

const myTool = defineTool({
  name: 'my_tool',
  description: '做一些有用的事情',
  params: {
    input: { type: 'string', description: '输入值' },
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

Agent 模板注册表。

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
  id: string;                          // 必需：唯一标识符
  name?: string;                       // 显示名称
  desc?: string;                       // 描述
  version?: string;                    // 模板版本
  systemPrompt: string;                // 必需：系统提示词
  model?: string;                      // 默认模型
  sandbox?: Record<string, any>;       // 沙箱配置
  tools?: '*' | string[];              // '*' 表示全部，或指定工具
  permission?: PermissionConfig;       // 权限配置
  runtime?: TemplateRuntimeConfig;     // 运行时选项
  hooks?: Hooks;                       // Hook 函数
  metadata?: Record<string, any>;      // 自定义元数据
}
```

---

## AgentPool

管理多个 Agent 实例。

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

多 Agent 协作空间。

```typescript
class Room {
  constructor(pool: AgentPool);

  join(name: string, agentId: string): void;
  leave(name: string): void;
  async say(from: string, text: string): Promise<void>;
  getMembers(): RoomMember[];
}
```

**示例：**
```typescript
const pool = new AgentPool({ dependencies: deps });
const room = new Room(pool);

// 创建并加入 agents
const agent1 = await pool.create('agent-1', config);
const agent2 = await pool.create('agent-2', config);

room.join('Alice', 'agent-1');
room.join('Bob', 'agent-2');

// 广播消息
await room.say('Alice', 'Hello everyone!');

// 定向消息
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
  process.env.ANTHROPIC_BASE_URL, // 可选
  process.env.HTTPS_PROXY, // 可选
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
  process.env.OPENAI_BASE_URL, // 可选
  process.env.HTTPS_PROXY, // 可选
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
  process.env.GEMINI_BASE_URL, // 可选
  process.env.HTTPS_PROXY, // 可选
  {
    thinking: { level: 'medium' },
  }
);
```

---

## 内置工具

| 工具 | 说明 |
|------|------|
| `fs_read` | 读取文件内容 |
| `fs_write` | 创建/覆写文件 |
| `fs_edit` | 编辑文件（替换）|
| `fs_glob` | 使用 glob 模式匹配文件 |
| `fs_grep` | 在文件中搜索文本/正则 |
| `fs_multi_edit` | 批量编辑多个文件 |
| `bash_run` | 执行 shell 命令 |
| `bash_logs` | 读取后台命令输出 |
| `bash_kill` | 终止后台命令 |
| `todo_read` | 读取 Todo 列表 |
| `todo_write` | 写入 Todo 列表 |
| `task_run` | 派发子 Agent |
| `skills` | 加载技能 |

### 注册内置工具

```typescript
import { builtin, ToolRegistry } from '@shareai-lab/kode-sdk';

const registry = new ToolRegistry();

// builtin 是一个包含方法的对象，每个方法返回 ToolInstance[]
for (const tool of [...builtin.fs(), ...builtin.bash(), ...builtin.todo()]) {
  registry.register(tool.name, () => tool);
}

// 或分组注册特定工具
builtin.fs().forEach(tool => registry.register(tool.name, () => tool));
builtin.bash().forEach(tool => registry.register(tool.name, () => tool));
builtin.todo().forEach(tool => registry.register(tool.name, () => tool));
```

**可用的 builtin 分组：**
- `builtin.fs()` - 文件系统工具：`fs_read`, `fs_write`, `fs_edit`, `fs_glob`, `fs_grep`, `fs_multi_edit`
- `builtin.bash()` - Shell 工具：`bash_run`, `bash_logs`, `bash_kill`
- `builtin.todo()` - Todo 工具：`todo_read`, `todo_write`
- `builtin.task(templates)` - 子 Agent 工具：`task_run`（需要提供模板）

---

## SkillsManager

在 Agent 运行时管理技能。

```typescript
class SkillsManager {
  constructor(skillsDir: string, whitelist?: string[]);

  async getSkillsMetadata(): Promise<SkillMetadata[]>;
  async loadSkillContent(skillName: string): Promise<SkillContent | null>;
}
```

---

## 工具函数

### generateAgentId()

生成唯一的 Agent ID。

```typescript
import { generateAgentId } from '@shareai-lab/kode-sdk';

const agentId = generateAgentId(); // 例如 'agt-abc123xyz'
```

---

## E2BSandbox

基于 [E2B](https://e2b.dev) 的云端沙箱，提供隔离的代码执行环境。

### 构造函数

```typescript
new E2BSandbox(options?: E2BSandboxOptions)
```

### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `init()` | `async init(): Promise<void>` | 初始化（创建或连接）沙箱 |
| `exec(cmd, opts?)` | `async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<SandboxExecResult>` | 执行命令 |
| `dispose()` | `async dispose(): Promise<void>` | 销毁沙箱并清理资源 |
| `getSandboxId()` | `getSandboxId(): string` | 获取沙箱 ID（用于持久化） |
| `getHostUrl(port)` | `getHostUrl(port: number): string` | 获取端口的可访问 URL |
| `setTimeout(ms)` | `async setTimeout(timeoutMs: number): Promise<void>` | 延长沙箱生命周期 |
| `isRunning()` | `async isRunning(): Promise<boolean>` | 检查沙箱是否运行中 |
| `watchFiles(paths, listener)` | `async watchFiles(...): Promise<string>` | 监听文件变更 |
| `unwatchFiles(id)` | `unwatchFiles(id: string): void` | 停止监听 |
| `getE2BInstance()` | `getE2BInstance(): E2BSdk` | 获取底层 E2B SDK 实例 |

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `kind` | `'e2b'` | 沙箱类型标识 |
| `workDir` | `string` | 工作目录路径 |
| `fs` | `SandboxFS` | 文件系统操作 |

---

## OpenSandbox

基于 [OpenSandbox](https://www.npmjs.com/package/@alibaba-group/opensandbox) 的自托管沙箱，用于隔离代码执行。

### 构造函数

```typescript
new OpenSandbox(options: OpenSandboxOptions)
```

### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `init()` | `async init(): Promise<void>` | 初始化（创建或连接）沙箱 |
| `exec(cmd, opts?)` | `async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<SandboxExecResult>` | 执行命令 |
| `dispose()` | `async dispose(): Promise<void>` | 按生命周期策略释放沙箱 |
| `getSandboxId()` | `getSandboxId(): string \| undefined` | 获取沙箱 ID（用于持久化） |
| `isRunning()` | `async isRunning(): Promise<boolean>` | 检查沙箱是否运行中 |
| `watchFiles(paths, listener)` | `async watchFiles(...): Promise<string>` | 监听文件变更（支持 polling 回退） |
| `unwatchFiles(id)` | `unwatchFiles(id: string): void` | 停止监听 |
| `getOpenSandbox()` | `getOpenSandbox(): OpenSandboxClient` | 获取底层 OpenSandbox 客户端 |

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `kind` | `'opensandbox'` | 沙箱类型标识 |
| `workDir` | `string` | 工作目录路径 |
| `fs` | `SandboxFS` | 文件系统操作 |

---

## E2BTemplateBuilder

构建自定义 E2B 沙箱模板的静态工具类。

### 静态方法

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

## 参考资料

- [类型参考](./types.md)
- [事件参考](./events-reference.md)
- [使用指南](../guides/events.md)
- [E2B 沙箱指南](../guides/e2b-sandbox.md)
- [OpenSandbox 沙箱指南](../guides/opensandbox-sandbox.md)
