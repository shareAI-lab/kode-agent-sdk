# 核心概念

## 什么是 KODE SDK？

KODE SDK 是一个 **Agent 运行时内核** — 它管理 AI Agent 的完整生命周期，包括状态持久化、崩溃恢复和工具执行。

可以把它类比为 **JavaScript 的 V8**，但是针对 AI Agent：

```
+------------------+     +------------------+
|       V8         |     |    KODE SDK      |
|  JS 运行时       |     |  Agent 运行时    |
+------------------+     +------------------+
        |                        |
        v                        v
+------------------+     +------------------+
|    Express.js    |     |   你的应用       |
|  Web 框架        |     | (CLI/桌面/Web)   |
+------------------+     +------------------+
```

**KODE SDK 提供：**
- Agent 生命周期管理（创建、运行、暂停、恢复、分叉）
- 带崩溃恢复的状态持久化（WAL 保护）
- 带权限治理的工具执行
- 三通道事件系统用于可观测性

**KODE SDK 不提供：**
- HTTP 路由或 API 框架
- 用户认证或授权
- 多租户或资源隔离
- 水平扩展（这部分由你来架构）

> 深入了解架构，请参阅 [架构指南](../advanced/architecture.md)

---

## Agent

Agent 是管理与 LLM 模型对话的核心实体。

```typescript
// 设置依赖
const templates = new AgentTemplateRegistry();
templates.register({
  id: 'assistant',
  systemPrompt: '你是一个乐于助人的助手。',
  tools: ['fs_read', 'fs_write'],  // 可选：工具名称
});

// 创建 Agent
const agent = await Agent.create(
  { templateId: 'assistant' },
  { store, templateRegistry: templates, toolRegistry: tools, sandboxFactory, modelFactory }
);
```

核心能力：
- **发送消息**：`agent.send('...')` 或 `agent.send(contentBlocks)`
- **订阅事件**：`agent.subscribe(['progress'])` 或 `agent.on('event_type', callback)`
- **从存储恢复**：`Agent.resume(agentId, config, deps)` 或 `Agent.resumeFromStore(agentId, deps)`
- **分叉对话**：`agent.fork()`

## 三通道事件系统

KODE SDK 将事件分为三个通道，实现清晰的架构分离：

### Progress 通道

用于 UI 展示的实时流数据。使用 `subscribe()`：

```typescript
for await (const envelope of agent.subscribe(['progress'])) {
  switch (envelope.event.type) {
    case 'text_chunk':      // 模型输出的文本片段
      process.stdout.write(envelope.event.delta);
      break;
    case 'tool:start':      // 工具开始执行
    case 'tool:end':        // 工具执行完成
    case 'done':            // 响应完成
  }
}
```

### Control 通道

需要人工或系统决策的审批请求。使用 `on()`：

```typescript
agent.on('permission_required', async (event) => {
  // 批准或拒绝工具执行
  await event.respond('allow');  // 或 event.respond('deny', { note: '原因' })
});
```

### Monitor 通道

审计和可观测性事件。使用 `on()`：

```typescript
agent.on('tool_executed', (event) => {
  console.log('工具:', event.call.name, '耗时:', event.call.durationMs);
});

agent.on('token_usage', (event) => {
  console.log('Token:', event.totalTokens);
});

agent.on('error', (event) => {
  console.error('错误:', event.message);
});
```

## 工具 (Tools)

工具扩展 Agent 的能力。KODE 提供内置工具并支持自定义工具。

### 内置工具

| 类别 | 工具 |
|------|------|
| 文件系统 | `fs_read`, `fs_write`, `fs_edit`, `fs_glob`, `fs_grep` |
| Shell | `bash_run`, `bash_logs`, `bash_kill` |
| 任务管理 | `todo_read`, `todo_write` |

### 自定义工具

```typescript
import { defineTool } from '@shareai-lab/kode-sdk';

const weatherTool = defineTool({
  name: 'get_weather',
  description: '获取城市天气',
  params: {
    city: { type: 'string', description: '城市名称' }
  },
  attributes: { readonly: true },
  async exec(args, ctx) {
    return { temp: 22, condition: '晴天' };
  }
});
```

## Store（存储）

Agent 状态的持久化后端。

| Store 类型 | 使用场景 |
|------------|----------|
| `JSONStore` | 开发环境、单实例 |
| `SqliteStore` | 生产环境、单机部署 |
| `PostgresStore` | 生产环境、多实例部署 |

```typescript
// JSONStore（默认）
const store = new JSONStore('./.kode');

// SQLite
const store = new SqliteStore('./agents.db', './data');

// PostgreSQL
const store = new PostgresStore(connectionConfig, './data');

// 工厂函数
const store = createExtendedStore({
  type: 'sqlite',
  dbPath: './agents.db',
  fileStoreBaseDir: './data'
});
```

## Sandbox（沙箱）

工具执行的隔离环境。

```typescript
const agent = await Agent.create({
  templateId: 'assistant',
  sandbox: {
    kind: 'local',
    workDir: './workspace',
    enforceBoundary: true,  // 限制文件访问在 workDir 内
  }
}, deps);
```

## Provider（模型提供者）

模型 Provider 适配器。KODE 内部使用 Anthropic 风格的消息格式。

```typescript
// Anthropic
const provider = new AnthropicProvider(apiKey, modelId);

// OpenAI
const provider = new OpenAIProvider(apiKey, modelId);

// Gemini
const provider = new GeminiProvider(apiKey, modelId);
```

## Resume（恢复）与 Fork（分叉）

### Resume（恢复）

从崩溃恢复或稍后继续：

```typescript
// 恢复已有 Agent
const agent = await Agent.resume(agentId, config, deps);

// 恢复或创建新的
const exists = await store.exists(agentId);
const agent = exists
  ? await Agent.resume(agentId, config, deps)
  : await Agent.create(config, deps);
```

### Fork（分叉）

在检查点处分叉对话：

```typescript
// 创建快照
const snapshotId = await agent.snapshot('before-risky-operation');

// 从快照分叉
const forkedAgent = await agent.fork(snapshotId);

// 每个 Agent 独立继续
await forkedAgent.send('尝试另一种方案');
```

## 多模态内容

KODE SDK 支持多模态输入，包括图像、PDF 文件和音频：

```typescript
import { ContentBlock } from '@shareai-lab/kode-sdk';

// 发送带图片的文本
const content: ContentBlock[] = [
  { type: 'text', text: '这张图片里有什么？' },
  { type: 'image', base64: imageBase64, mime_type: 'image/png' }
];

await agent.send(content);
```

配置多模态行为：

```typescript
const agent = await Agent.create({
  templateId: 'vision-assistant',
  multimodalContinuation: 'history',      // 在历史中保留多模态内容
  multimodalRetention: { keepRecent: 3 }, // 保留最近 3 条多模态消息
}, deps);
```

## 扩展思维

启用模型通过扩展思维"思考"复杂问题：

```typescript
const agent = await Agent.create({
  templateId: 'reasoning-assistant',
  exposeThinking: true,   // 向 Progress 通道发出思维事件
  retainThinking: true,   // 在消息历史中持久化思维
}, deps);

// 监听思维事件
for await (const envelope of agent.subscribe(['progress'])) {
  if (envelope.event.type === 'think_chunk') {
    console.log('[思考]', envelope.event.delta);
  }
}
```

## 下一步

- [事件系统](../guides/events.md) - 深入了解事件系统
- [工具系统](../guides/tools.md) - 内置和自定义工具
- [数据库存储](../guides/database.md) - 持久化选项
- [多模态指南](../guides/multimodal.md) - 图像、PDF 和音频
- [扩展思维指南](../guides/thinking.md) - 扩展思维和推理
