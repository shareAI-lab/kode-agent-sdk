# API 参考（v2.7）

本文聚焦 KODE SDK 的核心入口：依赖注入、Agent 创建/恢复、事件订阅、常用管理器与工具系统。其余专题文档请参考 `docs/` 目录。

---

## 依赖注入（AgentDependencies）

所有 Agent 都运行在明确的依赖容器里：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `store` | `Store` | 统一 WAL 的持久化实现（默认使用 `JSONStore`）。|
| `templateRegistry` | `AgentTemplateRegistry` | 模板注册中心，定义系统提示、默认工具、运行时策略。|
| `sandboxFactory` | `SandboxFactory` | 根据配置创建沙箱（local/docker/k8s/remote/vfs）。|
| `toolRegistry` | `ToolRegistry` | 注册所有可用工具（内置 & 自定义 & MCP）。|
| `modelFactory` | `(config: ModelConfig) => ModelProvider` | 可选。未提供时默认支持 `provider = anthropic`。|

```typescript
import {
  AgentDependencies,
  AgentTemplateRegistry,
  JSONStore,
  SandboxFactory,
  ToolRegistry,
  builtin,
  AnthropicProvider,
} from '@kode/sdk';

export function createDependencies(): AgentDependencies {
  const store = new JSONStore('./.kode');
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  templates.register({
    id: 'repo-assistant',
    systemPrompt: 'You are the repo teammate.',
    tools: ['fs_read', 'fs_write', 'fs_edit', 'bash_run', 'todo_read', 'todo_write'],
    runtime: { todo: { enabled: true, reminderOnStart: true, remindIntervalSteps: 25 } },
  });

  for (const tool of [...builtin.fs(), ...builtin.bash(), ...builtin.todo()]) {
    tools.register(tool.name, () => tool);
  }

  return {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
    // Configuration-driven model factory with provider-specific options
    modelFactory: (config) => {
      if (config.provider === 'anthropic') {
        return new AnthropicProvider(config.apiKey!, config.model, config.baseUrl, config.proxyUrl, {
          reasoningTransport: config.reasoningTransport,
          thinking: config.thinking,
          beta: { interleavedThinking: true },
        });
      }
      if (config.provider === 'openai') {
        return new OpenAIProvider(config.apiKey!, config.model, config.baseUrl, config.proxyUrl, {
          api: config.api ?? 'chat',
          reasoningTransport: config.reasoningTransport,
          responses: config.responses,
          reasoning: config.reasoning,
        });
      }
      if (config.provider === 'gemini') {
        return new GeminiProvider(config.apiKey!, config.model, config.baseUrl, config.proxyUrl, {
          reasoningTransport: config.reasoningTransport,
          thinking: config.thinking,
        });
      }
      // Default to OpenAI-compatible provider
      return new OpenAIProvider(config.apiKey!, config.model, config.baseUrl, config.proxyUrl, {
        reasoningTransport: config.reasoningTransport,
        reasoning: config.reasoning,
      });
    },
  };
}
```

---

## Agent.create(config, deps)

| 字段 | 说明 |
| --- | --- |
| `templateId` | 必填。引用已注册模板。|
| `agentId?` | 可选。未指定时自动生成 `agt:` 前缀 ULID。|
| `model` / `modelConfig` | 提供 `ModelProvider` 实例或配置。|
| `sandbox` | `Sandbox` 实例或 `SandboxConfig`（kind/workDir/enforceBoundary/allowPaths 等）。|
| `tools` | 工具名称数组。默认遵循模板：`'*'` 表示注册表所有工具。|
| `exposeThinking` | 是否推送 `progress.think_*`。模板 metadata 也可配置。|
| `overrides.*` | 覆盖模板的 permission/todo/subagents/hooks。|
| `context` | 上下文管理参数（maxTokens / compressToTokens / compressionModel 等）。|
| `metadata` | 透传字段：`toolTimeoutMs`、`maxToolConcurrency`、`maxTokens`、`temperature` 等。|

返回值为 `Promise<Agent>`。初始化流程：

1. 根据模板及 `config.tools` 解析工具实例 → 自动注入工具说明书。
2. 构建沙箱 + FilePool watcher。
3. 从 Store 恢复消息、工具记录、Todo、断点、Lineage。
4. 设置事件总线，READY 状态等待消息。

---

## Agent.resume / Agent.resumeFromStore

```typescript
const agent = await Agent.resume('agt:demo', {
  templateId: 'repo-assistant',
  modelConfig: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', apiKey: process.env.ANTHROPIC_API_KEY! },
  sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true },
}, deps, {
  strategy: 'crash',  // 自动封口未完成工具
  autoRun: true,      // 恢复后继续处理队列
});

const agent2 = await Agent.resumeFromStore('agt:demo', deps, {
  overrides: { modelConfig: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', apiKey: process.env.ANTHROPIC_API_KEY! } },
});
```

- `strategy: 'manual' | 'crash'`：`crash` 会自动封口未完成工具并发 `monitor.agent_resumed`。
- `autoRun`：恢复后立即继续处理队列。
- `overrides`：对读取到的 metadata 做精细覆盖（模型、权限、sandbox 等）。

恢复后务必重新绑定事件监听（Control/Monitor 回调不会随 metadata 存储）。

---

## Agent 实例 API

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `send(text, opts?)` | `Promise<string>` | 入队消息（`kind: 'user' | 'reminder'`）。REMINDER 会自动包裹系统提示。|
| `chat(text, opts?)` | `Promise<CompleteResult>` | 阻塞式单轮对话，返回最后一条文本与 `permissionIds`。|
| `chatStream(text, opts?)` / `stream` | `AsyncIterable<ProgressEvent>` | 推拉式流，见 Progress 通道。|
| `subscribe(channels, opts?)` | `AsyncIterable<AgentEventEnvelope>` | 订阅任意组合的 Progress/Control/Monitor，支持 `since`/`kinds` 过滤。|
| `on(type, handler)` | `() => void` | 订阅 Control/Monitor 回调（审批、错误、tool_executed、todo_changed 等）。|
| `schedule()` | `Scheduler` | 注册步数调度、外部触发。详见 Scheduler 文档。|
| `snapshot(label?)` | `Promise<SnapshotId>` | 创建 Safe-Fork-Point。|
| `fork(sel?)` | `Promise<Agent>` | 基于 snapshot 派生新 Agent（继承工具/权限/lineage）。|
| `status()` / `info()` | `Promise<AgentStatus/AgentInfo>` | 读取运行状态、断点、cursor、lineage。|
| `getTodos()` / `setTodos()` / `updateTodo()` / `deleteTodo()` | 管理 Todo 列表，自动触发 Monitor 事件。|
| `decide(id, decision, note?)` | `Promise<void>` | 审批 Control 请求（通常配合自定义审批服务）。|
| `interrupt(opts?)` | `Promise<void>` | 中断当前工具，封口 `tool_result`，恢复 READY。|

---

## 事件通道

### Progress（数据面）

| 事件 | 说明 |
| --- | --- |
| `think_chunk_start/think_chunk/think_chunk_end` | 暴露模型思考。受 `exposeThinking` 控制。|
| `text_chunk_start/text_chunk/text_chunk_end` | 文本增量输送。|
| `tool:start/tool:end/tool:error` | 工具生命周期 & 错误。`tool:end` 始终推送，即使失败。|
| `done` | 当前轮结束，返回 `bookmark`（`seq/timestamp`）。|

`subscribe(['progress'], { since, kinds })` 支持直播 + 续播。`bookmark` 可用于前端断点续传。

### Control（审批面）

| 事件 | 说明 |
| --- | --- |
| `permission_required` | 工具被策略/Hooks 判定需要审批。包含 `call`（快照）、`respond(decision, opts?)`。|
| `permission_decided` | 审批结果广播，含 `callId`、`decision`、`decidedBy`。|

### Monitor（治理面）

核心事件：

- `state_changed`：READY / WORKING / PAUSED 切换。
- `tool_executed`：工具完成，含耗时、审批信息、结果摘要。
- `error`：分类错误（model/tool/system），带 `severity` 与 `detail`。
- `todo_changed` / `todo_reminder`：Todo 更新 & 提醒。
- `file_changed`：FilePool 发现外部修改。
- `context_compression`：上下文压缩摘要与比率。
- `agent_resumed`：Resume 完成及自动封口列表。
- `tool_manual_updated`：注入的工具说明书更新。

Monitor 事件默认只在必要时推送，避免 UI 噪音。

---

## 工具系统速览

- 所有工具必须注册到 `ToolRegistry`，`Agent.create`/`resume` 会根据模板/配置实例化。
- 内置工具分组：`builtin.fs()`、`builtin.bash()`、`builtin.todo()`、`builtin.task(templates)`、`builtin.skills(skillsManager)`。
- 推荐使用 `defineTool`/`defineTools` 或 `tool()/tools()`（Zod）封装，自动生成 JSON Schema 与自定义事件。
- 工具执行上下文(`ToolContext`)包含 `agent`, `sandbox`, `store`, `signal`, `events` 等；请响应 `AbortSignal`。
- 工具返回结构若带 `{ ok: false, error, recommendations }`，会自动生成结构化审计事件。

### Skills 工具注册

Skills工具需要先创建`SkillsManager`实例，然后注册到工具注册表：

```typescript
import { createSkillsTool } from '@kode/sdk';
import { SkillsManager } from '@kode/sdk';

// 创建Skills管理器
const skillsManager = new SkillsManager('./skills', ['skill1', 'skill2']);

// 注册Skills工具
deps.toolRegistry.register('skills', () => createSkillsTool(skillsManager));
```

Skills系统特性：
- **热重载**：Skills代码修改后自动重新加载
- **元数据注入**：自动将技能描述注入到系统提示
- **沙箱隔离**：每个技能有独立的文件系统空间
- **白名单机制**：支持选择性加载特定技能

更多细节见 [`docs/tools.md`](./tools.md)、[`docs/simplified-tools.md`](./simplified-tools.md) 与 [`docs/skills.md`](./skills.md)。

---

## Todo 与提醒

启用模板的 `runtime.todo.enabled = true` 后：

- `TodoService` 会从 Store 加载/持久化，限制同一时间最多一个 `in_progress`。
- `agent.todoManager` 自动触发提醒：
  - 初始化提醒（`reminderOnStart`）。
  - `remindIntervalSteps` 间隔触发系统消息（Progress 不推送，默认 Monitor 提醒）。
- `todo_read`/`todo_write` 工具会自动注入，直接被模型使用。

---

## Scheduler

`agent.schedule()` 返回 `Scheduler`：

```typescript
const scheduler = agent.schedule();
const handle = scheduler.everySteps(5, ({ stepCount }) => {
  console.log('reminder every 5 steps', stepCount);
  agent.send('系统提醒：请总结当前进度。', { kind: 'reminder' });
});

// 外部触发
scheduler.notifyExternalTrigger({ taskId: 'cron:daily', spec: '0 9 * * *', kind: 'cron' });
```

触发时会推送 `monitor.scheduler_triggered` 事件，便于审计。

---

## FilePool 与 Sandbox

- 所有文件类工具自动调用 FilePool：读取/写入记录时间戳、防止陈旧写入。
- 外部修改 → `monitor.file_changed` + 系统提醒（通过 `agent.remind`）。
- Sandbox 默认 `enforceBoundary: true`，可通过模板 metadata 的 `sandbox` 或 Agent 配置放权 `allowPaths`。
- `LocalSandbox` 自动阻止危险命令（`rm -rf /`、`curl | bash` 等）。

---

## 错误处理

- 工具错误 → `tool:error` (Progress) + `monitor.error`（`severity: warn/error`）。
- 模型错误 → `monitor.error`（`phase: model`）。
- 自动封口（Seal）默认恢复 READY，并写入带建议的 `tool_result`。
- 可通过 HookManager (`preToolUse`/`postToolUse`/`preModel`/`postModel`) 注入治理逻辑。

---

## 相关文档

- [`docs/events.md`](./events.md)：事件驱动最佳实践。
- [`docs/resume.md`](./resume.md)：恢复/分叉策略 & 业务职责分工。
- [`docs/playbooks.md`](./playbooks.md)：典型场景脚本（收件箱、审批、多 Agent、调度）。
- [`docs/simplified-tools.md`](./simplified-tools.md)：工具定义 API。
