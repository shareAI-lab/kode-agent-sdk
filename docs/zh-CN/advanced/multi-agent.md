# 多 Agent 系统

本指南介绍如何使用 KODE SDK 的协调原语构建多 Agent 系统：AgentPool、Room 和 task_run。

---

## 概览

| 组件 | 用途 |
|------|------|
| `AgentPool` | 使用共享依赖管理多个 Agent 实例 |
| `Room` | 使用 @提及 协调 Agent 之间的通信 |
| `task_run` | 将子任务委派给专业 Agent |

---

## AgentPool

管理多个 Agent 实例的生命周期操作。

### 基本用法

```typescript
import { AgentPool } from '@shareai-lab/kode-sdk';

const pool = new AgentPool({
  dependencies: deps,
  maxAgents: 50,  // 默认：50
});

// 创建 agents
const agent1 = await pool.create('agent-1', {
  templateId: 'researcher',
  modelConfig: { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! },
});

const agent2 = await pool.create('agent-2', {
  templateId: 'coder',
  modelConfig: { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! },
});

// 通过 ID 获取 agent
const agent = pool.get('agent-1');

// 列出所有 agents
const agentIds = pool.list(); // ['agent-1', 'agent-2']

// 使用前缀过滤
const researchers = pool.list({ prefix: 'researcher-' });
```

### AgentPool API

```typescript
class AgentPool {
  constructor(opts: AgentPoolOptions);

  // 创建新 agent
  async create(agentId: string, config: AgentConfig): Promise<Agent>;

  // 获取已有 agent
  get(agentId: string): Agent | undefined;

  // 列出 agent ID
  list(opts?: { prefix?: string }): string[];

  // 获取 agent 状态
  async status(agentId: string): Promise<AgentStatus | undefined>;

  // 分叉 agent
  async fork(agentId: string, snapshotSel?: SnapshotId | { at?: string }): Promise<Agent>;

  // 从存储恢复
  async resume(agentId: string, config: AgentConfig, opts?: {
    autoRun?: boolean;
    strategy?: 'crash' | 'manual';
  }): Promise<Agent>;

  // 删除 agent
  async delete(agentId: string): Promise<void>;
}
```

---

## Room

使用广播和定向消息协调 Agent 之间的通信。

### 基本用法

```typescript
import { AgentPool, Room } from '@shareai-lab/kode-sdk';

const pool = new AgentPool({ dependencies: deps });
const room = new Room(pool);

// 创建并加入 agents
const alice = await pool.create('alice', config);
const bob = await pool.create('bob', config);
const charlie = await pool.create('charlie', config);

room.join('Alice', 'alice');
room.join('Bob', 'bob');
room.join('Charlie', 'charlie');

// 广播给所有人（发送者除外）
await room.say('Alice', 'Hello everyone!');
// Bob 和 Charlie 收到："[from:Alice] Hello everyone!"

// 使用 @提及 定向消息
await room.say('Alice', '@Bob What do you think about this?');
// 只有 Bob 收到："[from:Alice] @Bob What do you think about this?"

// 多个提及
await room.say('Alice', '@Bob @Charlie Please review.');
// Bob 和 Charlie 都收到消息

// 离开房间
room.leave('Charlie');

// 获取当前成员
const members = room.getMembers();
// [{ name: 'Alice', agentId: 'alice' }, { name: 'Bob', agentId: 'bob' }]
```

### Room API

```typescript
class Room {
  constructor(pool: AgentPool);

  // 加入房间
  join(name: string, agentId: string): void;

  // 离开房间
  leave(name: string): void;

  // 发送消息（广播或定向）
  async say(from: string, text: string): Promise<void>;

  // 获取成员
  getMembers(): RoomMember[];
}

interface RoomMember {
  name: string;
  agentId: string;
}
```

---

## task_run 工具

将任务委派给专业子 Agent。

### 设置

```typescript
import { createTaskRunTool, AgentTemplate } from '@shareai-lab/kode-sdk';

// 定义可用模板
const templates: AgentTemplate[] = [
  {
    id: 'researcher',
    whenToUse: '研究和收集信息',
    tools: ['fs_read', 'fs_glob', 'fs_grep'],
  },
  {
    id: 'coder',
    whenToUse: '编写和修改代码',
    tools: ['fs_read', 'fs_write', 'fs_edit', 'bash_run'],
  },
  {
    id: 'reviewer',
    whenToUse: '审查代码并提供反馈',
    tools: ['fs_read', 'fs_glob', 'fs_grep'],
  },
];

// 创建 task_run 工具
const taskRunTool = createTaskRunTool(templates);

// 注册
deps.toolRegistry.register('task_run', () => taskRunTool);
```

### task_run 工作原理

当 Agent 调用 `task_run` 时：

1. Agent 指定 `agentTemplateId`、`prompt`、可选 `context` 与可选 `model`
2. SDK 使用指定模板创建子 Agent
3. 子 Agent 处理任务
4. 结果返回给父 Agent

**工具参数：**

```typescript
interface TaskRunParams {
  description: string;      // 简短任务描述（3-5 词）
  prompt: string;           // 详细指令
  agentTemplateId: string;  // 使用的模板 ID
  context?: string;         // 额外上下文
  model?: string | { provider: string; model: string }; // 可选模型覆盖
}
```

**工具结果：**

```typescript
interface TaskRunResult {
  status: 'ok' | 'paused';
  template: string;
  text?: string;
  permissionIds?: string[];
}
```

**模型继承说明（`delegateTask`）：**
- `task_run` 支持可选 `model` 参数；不传时，默认让被委派的子 Agent 复用父 Agent 的 `ModelProvider` 实例。
- 如果你需要显式控制模型，请直接调用 `agent.delegateTask(...)`：
  - 不传 `model`：继承父模型实例
  - `model: string`：保持父 provider 类型，仅覆盖模型 ID（自定义 provider 需配合 `modelFactory`）
  - `model: { provider, model }`：显式指定 provider + model（provider 与父模型不同时，自定义 provider 通常需配合 `modelFactory`）
  - `model: ModelProvider`：直接使用传入的 provider 实例

### 子 Agent 配置

在模板中配置子 agent 行为：

```typescript
const template: AgentTemplateDefinition = {
  id: 'coordinator',
  systemPrompt: '你负责协调专家之间的任务...',
  tools: ['task_run', 'fs_read'],
  runtime: {
    subagents: {
      depth: 2,           // 最大嵌套深度
      templates: ['researcher', 'coder'],  // 允许的模板
      inheritConfig: true,
      overrides: {
        permission: { mode: 'auto' },
      },
    },
  },
};
```

---

## 模式

### 协调者模式

一个 Agent 协调多个专家。

```typescript
// 协调者模板
const coordinatorTemplate: AgentTemplateDefinition = {
  id: 'coordinator',
  systemPrompt: `你是项目协调者。分解复杂任务并委派给专家：
- 使用 'researcher' 进行信息收集
- 使用 'coder' 进行实现
- 使用 'reviewer' 进行代码审查

协调工作并综合结果。`,
  tools: ['task_run', 'fs_read', 'fs_write'],
  runtime: {
    subagents: {
      depth: 1,
      templates: ['researcher', 'coder', 'reviewer'],
    },
  },
};

// 使用
const coordinator = await Agent.create({
  templateId: 'coordinator',
  ...
}, deps);

await coordinator.send('实现一个用户认证系统');
// 协调者将委派：
// 1. researcher: "研究认证最佳实践"
// 2. coder: "实现认证模块"
// 3. reviewer: "审查认证实现"
```

### 流水线模式

按顺序链接 Agent。

```typescript
async function pipeline(input: string) {
  // 步骤 1：研究
  const researcher = await pool.create('researcher-1', {
    templateId: 'researcher',
    ...
  });
  const research = await researcher.send(`研究：${input}`);

  // 步骤 2：实现
  const coder = await pool.create('coder-1', {
    templateId: 'coder',
    ...
  });
  const implementation = await coder.send(`
    基于此研究：
    ${research}

    实现解决方案。
  `);

  // 步骤 3：审查
  const reviewer = await pool.create('reviewer-1', {
    templateId: 'reviewer',
    ...
  });
  const review = await reviewer.send(`
    审查此实现：
    ${implementation}
  `);

  return { research, implementation, review };
}
```

### 辩论模式

多个 Agent 讨论一个话题。

```typescript
const room = new Room(pool);

// 创建辩论者
const alice = await pool.create('alice', {
  templateId: 'debater',
  metadata: { position: 'pro' },
  ...
});
const bob = await pool.create('bob', {
  templateId: 'debater',
  metadata: { position: 'con' },
  ...
});

room.join('Alice', 'alice');
room.join('Bob', 'bob');

// 开始辩论
await room.say('Moderator', '话题：我们应该使用微服务吗？');

// 继续辩论轮次
for (let round = 0; round < 3; round++) {
  await room.say('Alice', `@Bob [第 ${round + 1} 轮] 这是我的论点...`);
  await room.say('Bob', `@Alice [第 ${round + 1} 轮] 我的反驳...`);
}
```

---

## 最佳实践

### 1. 限制深度

防止无限子 agent 链：

```typescript
runtime: {
  subagents: {
    depth: 2,  // 最大嵌套深度
  },
}
```

### 2. 清晰的模板

每个模板应有清晰的职责：

```typescript
const templates: AgentTemplate[] = [
  {
    id: 'data-analyst',
    whenToUse: '分析数据模式并生成洞察',
    tools: ['fs_read', 'fs_glob'],
  },
  // 避免职责重叠
];
```

### 3. 资源管理

完成后清理 agents：

```typescript
try {
  const agent = await pool.create('temp-agent', config);
  const result = await agent.send(message);
  return result;
} finally {
  await pool.destroy('temp-agent');
}
```

### 4. 权限继承

考虑子 agent 的权限设置：

```typescript
runtime: {
  subagents: {
    inheritConfig: true,
    overrides: {
      permission: { mode: 'approval' },  // 需要审批
    },
  },
}
```

---

## 监控多 Agent 系统

### 追踪子 Agent 事件

```typescript
agent.on('tool_executed', (event) => {
  if (event.call.name === 'task_run') {
    console.log('子 agent 完成:', {
      template: event.call.result?.template,
      status: event.call.result?.status,
    });
  }
});
```

### 聚合指标

```typescript
const allAgentIds = pool.list();
const stats = await Promise.all(
  allAgentIds.map(async (id) => {
    const status = await pool.status(id);
    return { id, ...status };
  })
);

console.log('总 agents:', stats.length);
console.log('工作中:', stats.filter(s => s.state === 'WORKING').length);
console.log('已暂停:', stats.filter(s => s.state === 'PAUSED').length);
```

---

## 参考资料

- [API 参考](../reference/api.md)
- [事件指南](../guides/events.md)
- [生产部署](./production.md)
