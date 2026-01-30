# 工具系统指南

KODE SDK 提供完整的工具系统，包含内置工具、自定义工具定义 API 和 MCP 集成。所有工具遵循以下规范：

- **Prompt 说明书**：每个工具都提供详细 Prompt，引导模型安全使用
- **结构化返回**：工具返回 JSON 结构（例如 `fs_read` 返回 `{ content, offset, limit, truncated }`）
- **FilePool 集成**：文件类工具自动通过 FilePool 校验与记录，防止新鲜度冲突
- **审计追踪**：ToolCallRecord 记录审批、耗时、错误信息，Resume 时完整恢复

---

## 内置工具

### 文件系统工具

| 工具 | 说明 | 返回字段 |
|------|------|----------|
| `fs_read` | 读取文件片段 | `{ path, offset, limit, truncated, content }` |
| `fs_write` | 创建/覆写文件，写前校验新鲜度 | `{ ok, path, bytes, length }` |
| `fs_edit` | 精确替换文本（支持 `replace_all`） | `{ ok, path, replacements, length }` |
| `fs_glob` | 使用 glob 模式匹配文件 | `{ ok, pattern, cwd, matches, truncated }` |
| `fs_grep` | 在文件/通配符集合中搜索文本/正则 | `{ ok, pattern, path, matches[] }` |
| `fs_multi_edit` | 批量编辑多个文件 | `{ ok, results[{ path, status, replacements, message? }] }` |

#### FilePool 说明

- `recordRead` / `recordEdit`：记录最近读取/写入时间，用于冲突检测
- `validateWrite`：写入前校验文件是否在此 Agent 读取后被外部修改
- `watchFiles`：自动监听文件变更，触发 `monitor.file_changed` 事件

### Bash 工具

- `bash_run`：支持前台/后台执行，可通过 Hook 或 `permission.mode='approval'` 控制敏感命令
- `bash_logs`：读取后台命令输出
- `bash_kill`：终止后台命令

**推荐安全策略：**

```typescript
const agent = await Agent.create({
  templateId: 'secure-runner',
  sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true },
  overrides: {
    hooks: {
      preToolUse(call) {
        if (call.name === 'bash_run' && !/^git /.test(call.args.cmd)) {
          return { decision: 'ask', meta: { reason: '非白名单命令' } };
        }
        return undefined;
      },
    },
  },
}, deps);
```

### Todo 工具

- `todo_read`：返回 Todo 列表
- `todo_write`：写入完整 Todo 列表（校验 ID 唯一、进行中 <=1）。结合 `TodoManager` 自动提醒与事件

### Task（子代理）

- `task_run`：根据模板池派发子 Agent，支持 `subagent_type`、`context`、`model_name` 参数
- 模板可以通过 `runtime.subagents` 限制深度与可选模板

### Skills 工具

> **⚠️ 注意**：默认 Skills 目录已从 `skills/` 更改为 `.skills/`，详见 [Skills 系统指南 - Breaking Changes](./skills.md#breaking-changes)

- `skills`：加载特定技能的详细内容（包含指令、references、scripts、assets）
  - **参数**：
    - `action`：操作类型（目前仅支持 `load`，`list` 操作已禁用）
    - `skill_name`：技能名称（当 action=load 时必需）
  - **返回**：
    ```typescript
    {
      ok: true,
      data: {
        name: string,           // 技能名称（文件夹名称）
        description: string,    // 技能描述
        content: string,        // SKILL.md 内容
        base_dir: string,       // 技能基础目录
        references: string[],   // 参考文档列表
        scripts: string[],      // 可用脚本列表
        assets: string[]        // 资源文件列表
      }
    }
    ```

详见 [skills.md](./skills.md) 获取完整的 Skills 系统文档。

---

## 定义自定义工具

### 使用 `defineTool()` 快速开始（推荐）

简化 API（v2.7+）从参数定义自动生成 JSON Schema：

```typescript
import { defineTool } from '@shareai-lab/kode-sdk';

const weatherTool = defineTool({
  name: 'get_weather',
  description: '获取天气信息',

  // 简洁的参数定义 - 自动生成 Schema
  params: {
    city: {
      type: 'string',
      description: '城市名称'
    },
    units: {
      type: 'string',
      description: '温度单位',
      enum: ['celsius', 'fahrenheit'],
      required: false,
      default: 'celsius'
    }
  },

  // 简化的属性标记
  attributes: {
    readonly: true,   // 只读工具
    noEffect: true    // 无副作用，可安全重试
  },

  async exec(args, ctx) {
    // 自定义事件
    ctx.emit('weather_fetched', { city: args.city });
    return { temperature: 22, condition: 'sunny' };
  }
});
```

### 使用 `defineTools()` 批量定义

```typescript
import { defineTools } from '@shareai-lab/kode-sdk';

const calculatorTools = defineTools([
  {
    name: 'add',
    description: '两数相加',
    params: {
      a: { type: 'number' },
      b: { type: 'number' }
    },
    attributes: { readonly: true, noEffect: true },
    async exec(args, ctx) {
      return args.a + args.b;
    }
  },
  {
    name: 'multiply',
    description: '两数相乘',
    params: {
      a: { type: 'number' },
      b: { type: 'number' }
    },
    attributes: { readonly: true, noEffect: true },
    async exec(args, ctx) {
      return args.a * args.b;
    }
  }
]);
```

### 传统 ToolInstance 接口

需要精细控制时，使用经典接口：

```typescript
const registry = new ToolRegistry();

registry.register('greet', () => ({
  name: 'greet',
  description: '向指定对象问好',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name']
  },
  prompt: 'Use this tool to greet teammates by name.',
  async exec(args) {
    return `Hello, ${args.name}!`;
  },
  toDescriptor() {
    return { source: 'registered', name: 'greet', registryId: 'greet' };
  },
}));
```

---

## 参数定义

### 基础类型

```typescript
params: {
  str: { type: 'string', description: '字符串' },
  num: { type: 'number', description: '数字' },
  bool: { type: 'boolean', description: '布尔值' },

  // 可选参数
  optional: { type: 'string', required: false },

  // 默认值
  withDefault: { type: 'number', default: 42 },

  // 枚举
  choice: {
    type: 'string',
    enum: ['option1', 'option2', 'option3']
  }
}
```

### 复杂类型

```typescript
params: {
  // 数组
  tags: {
    type: 'array',
    description: '标签列表',
    items: { type: 'string' }
  },

  // 嵌套对象
  profile: {
    type: 'object',
    description: '用户配置',
    properties: {
      email: { type: 'string' },
      age: { type: 'number', required: false },
      roles: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  }
}
```

### 直接使用 JSON Schema（高级）

需要 `pattern`、`minLength` 等约束时，直接使用 `input_schema`：

```typescript
defineTool({
  name: 'advanced_tool',
  description: '高级工具',
  input_schema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        pattern: '^[A-Z]{3}$',
        minLength: 3,
        maxLength: 3
      }
    },
    required: ['data']
  },
  async exec(args, ctx) {
    // ...
  }
});
```

---

## 工具属性

### `readonly` - 只读工具

表示工具不修改任何状态（文件、数据库、外部 API）：

```typescript
attributes: {
  readonly: true
}
```

**用途**：
- `readonly` 权限模式会自动放行只读工具
- 适用于查询、读取、计算等操作

### `noEffect` - 无副作用

表示工具可以安全重试，多次执行结果相同：

```typescript
attributes: {
  noEffect: true
}
```

**用途**：
- Resume 时可安全重新执行
- 适用于幂等操作（GET 请求、纯计算等）

### 默认行为

不设置 `attributes` 时，工具被视为：
- 非只读（可能写入）
- 有副作用（不可重试）

---

## 自定义事件

### 基本用法

```typescript
defineTool({
  name: 'process_data',
  description: '处理数据',
  params: { input: { type: 'string' } },

  async exec(args, ctx: EnhancedToolContext) {
    ctx.emit('processing_started', { input: args.input });
    const result = await heavyComputation(args.input);
    ctx.emit('processing_completed', { result, duration: 1234 });
    return result;
  }
});
```

### 监听自定义事件

```typescript
agent.on('tool_custom_event', (event) => {
  console.log(`[${event.toolName}] ${event.eventType}:`, event.data);
});
```

### 事件结构

```typescript
interface MonitorToolCustomEvent {
  channel: 'monitor';
  type: 'tool_custom_event';
  toolName: string;        // 工具名称
  eventType: string;       // 自定义事件类型
  data?: any;              // 事件数据
  timestamp: number;
  bookmark?: Bookmark;
}
```

---

## 工具超时与 AbortSignal

### 超时配置

默认工具执行超时为 **60 秒**，可通过 Agent 配置自定义：

```typescript
const agent = await Agent.create({
  templateId: 'my-assistant',
  metadata: {
    toolTimeoutMs: 120000, // 2 分钟
  }
}, deps);
```

### 处理 AbortSignal（必须）

所有自定义工具的 `exec()` 方法都会收到 `context.signal`，**必须**在耗时操作中检查：

```typescript
export class MyLongRunningTool implements ToolInstance {
  async exec(args: any, context: ToolContext) {
    // 在长时间操作前检查
    if (context.signal?.aborted) {
      throw new Error('Operation aborted');
    }

    // 将 signal 传递给底层 API
    const response = await fetch(url, { signal: context.signal });

    // 在循环中定期检查
    for (const item of items) {
      if (context.signal?.aborted) {
        throw new Error('Operation aborted');
      }
      await processItem(item);
    }

    return result;
  }
}
```

### CPU 密集型任务

对于纯计算任务（无 I/O），需要主动在循环中检查：

```typescript
for (let i = 0; i < args.iterations; i++) {
  // 每 100 次迭代检查一次
  if (i % 100 === 0 && context.signal?.aborted) {
    throw new Error('Computation aborted');
  }
  result.push(this.compute(i));
}
```

### 超时恢复策略

工具超时后，Agent 会：
1. 发送 `abort` 信号
2. 标记工具调用为 `FAILED` 状态
3. 生成 `tool_result` 包含超时信息
4. 继续下一轮 `runStep`

Resume 时，超时的工具调用会被自动封口（Auto-Seal），不会重新执行。

---

## MCP 集成

在 ToolRegistry 注册 MCP loader，将 `registryId` 指向 MCP 服务：

```typescript
const registry = new ToolRegistry();

// 注册 MCP 工具加载器
registry.registerMCPLoader('my-mcp-server', async () => {
  const client = await connectToMCPServer('my-mcp-server');
  return client.getTools();
});
```

配合 TemplateRegistry 指定哪些模板启用 MCP 工具，Resume 时即可正常恢复。

---

## 最佳实践

1. **始终检查 `context.signal?.aborted`** - 在长时间操作中
2. **将 signal 传递给支持 AbortSignal 的 API**（fetch、axios 等）
3. **设置合理的 `attributes`** - 帮助权限系统正确判断
4. **善用自定义事件** - 提供工具执行的可观测性
5. **优先使用 `defineTool()`** - 代码更简洁、类型安全
6. **仅在需要高级约束时使用 `input_schema`**
7. **监听超时事件进行告警**

```typescript
agent.on('error', (event) => {
  if (event.phase === 'tool' && event.message.includes('aborted')) {
    console.log('Tool execution timed out:', event.detail);
  }
});
```

---

## 从旧 API 迁移

### Metadata 映射

| 旧方式 | 新方式 |
|--------|--------|
| `{ access: 'read', mutates: false }` | `{ readonly: true }` |
| `{ access: 'write', mutates: true }` | （默认，无需设置） |
| `{ safe: true }` | `{ noEffect: true }` |

### 添加自定义事件

```typescript
// 旧方式 - 无法发射事件
async exec(args, ctx: ToolContext) {
  return result;
}

// 新方式 - 可以发射事件
async exec(args, ctx: EnhancedToolContext) {
  ctx.emit('event_name', { data: 'value' });
  return result;
}
```

---

## 常见问题

**Q: 必须使用新 API 吗？**

A: 不，旧的 `ToolInstance` 接口完全兼容。新 API 是可选的增强功能。

**Q: `readonly` 和 `noEffect` 有什么区别？**

A:
- `readonly`：工具不修改任何状态（文件、数据库等）
- `noEffect`：工具可以安全重试，多次执行结果相同

一个只读工具通常也是无副作用的，但反之不一定成立。

**Q: 自定义事件会被持久化吗？**

A: 是的，自定义事件作为 `MonitorToolCustomEvent` 被完整持久化到 WAL，Resume 时可恢复。

**Q: 可以混用新旧 API 吗？**

A: 可以自由混用，Agent 接受任何 `ToolInstance`：

```typescript
const agent = await Agent.create({
  tools: [
    oldStyleTool,           // 旧方式
    defineTool({ ... }),    // 新方式
    new FsRead(),           // 内置工具
  ]
});
```

---

## 参考

- 示例代码：`examples/tooling/simplified-tools.ts`
- 类型定义：`src/tools/define.ts`
- 事件系统：[events.md](./events.md)
