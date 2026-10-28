# 生产部署

本指南介绍 KODE SDK 的生产配置、监控和最佳实践。

---

## 数据库选择

### 开发 vs 生产

| Store | 使用场景 | 特性 |
|-------|----------|------|
| `JSONStore` | 开发环境、单机 | 简单文件存储 |
| `SqliteStore` | 开发环境、中等规模 | QueryableStore + ExtendedStore |
| `PostgresStore` | 生产环境、多 Worker | 完整 ExtendedStore、分布式锁 |

### PostgreSQL 配置

```typescript
import { createStore } from '@shareai-lab/kode-sdk';

const store = await createStore({
  type: 'postgres',
  connection: {
    host: process.env.PG_HOST!,
    port: 5432,
    database: 'kode_agents',
    user: process.env.PG_USER!,
    password: process.env.PG_PASSWORD!,
    ssl: { rejectUnauthorized: true },

    // 连接池设置
    max: 20,                       // 连接池大小
    idleTimeoutMillis: 30000,      // 空闲连接超时
    connectionTimeoutMillis: 5000, // 连接超时
  },
  fileStoreBaseDir: '/data/kode-files',
});
```

---

## 健康检查

ExtendedStore 提供内置健康检查能力。

### 健康检查 API

```typescript
const health = await store.healthCheck();

// 响应：
// {
//   healthy: true,
//   database: { connected: true, latencyMs: 5 },
//   fileSystem: { writable: true },
//   checkedAt: 1706000000000
// }
```

### HTTP 健康端点

```typescript
import express from 'express';

const app = express();

app.get('/health', async (req, res) => {
  const status = await store.healthCheck();
  res.status(status.healthy ? 200 : 503).json(status);
});

// Kubernetes 就绪探针
app.get('/ready', async (req, res) => {
  const status = await store.healthCheck();
  res.status(status.healthy ? 200 : 503).send();
});
```

### 数据一致性检查

```typescript
const consistency = await store.checkConsistency(agentId);

if (!consistency.consistent) {
  console.error('一致性问题:', consistency.issues);
}
```

---

## 指标与监控

### Store 指标

```typescript
const metrics = await store.getMetrics();

// {
//   operations: { saves: 1234, loads: 5678, queries: 910, deletes: 11 },
//   performance: { avgLatencyMs: 15.5, maxLatencyMs: 250, minLatencyMs: 2 },
//   storage: { totalAgents: 100, totalMessages: 50000, dbSizeBytes: 104857600 },
//   collectedAt: 1706000000000
// }
```

### Prometheus 集成

```typescript
import { register, Gauge, Histogram } from 'prom-client';

const agentCount = new Gauge({ name: 'kode_agents_total', help: 'Agent 总数' });
const toolLatency = new Histogram({
  name: 'kode_tool_duration_seconds',
  help: '工具执行耗时',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

agent.on('tool_executed', (event) => {
  if (event.call.durationMs) {
    toolLatency.observe(event.call.durationMs / 1000);
  }
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});
```

---

## 重试策略

### 内置重试配置

```typescript
import { withRetry, DEFAULT_RETRY_CONFIG } from '@shareai-lab/kode-sdk/provider';

// 默认配置: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 60000, jitterFactor: 0.2 }

const result = await withRetry(
  () => callExternalAPI(),
  { maxRetries: 5, baseDelayMs: 500, provider: 'myservice' },
  (error, attempt, delay) => console.log(`重试 ${attempt} 等待 ${delay}ms`)
);
```

### 可重试错误

| 错误类型 | 可重试 | 说明 |
|----------|--------|------|
| `RateLimitError` | 是 | 遵循 `retry-after` 头 |
| `TimeoutError` | 是 | 请求超时 |
| `ServiceUnavailableError` | 是 | 5xx 服务器错误 |
| `AuthenticationError` | 否 | 无效凭证 |
| `QuotaExceededError` | 否 | 账单限额 |

---

## 分布式锁

### 使用 Agent 锁

```typescript
const release = await store.acquireAgentLock(agentId, 30000);

try {
  const agent = await Agent.resumeFromStore(agentId, deps);
  await agent.send('处理此任务');
} finally {
  await release();
}
```

- **SQLite**: 内存锁（仅单进程有效）
- **PostgreSQL**: 数据库级咨询锁（多 Worker 安全）

---

## 优雅关闭

```typescript
async function gracefulShutdown() {
  // 1. 停止接受新请求
  server.close();

  // 2. 中断运行中的 Agent
  for (const agentId of pool.list()) {
    const agent = pool.get(agentId);
    if (agent) await agent.interrupt();
  }

  // 3. 关闭数据库连接
  await store.close();

  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
```

---

## 日志与成本管理

### Logger 接口

```typescript
const config: DebugConfig = {
  verbose: false,
  logTokenUsage: true,
  logCache: true,
  logRetries: true,
  redactSensitive: true,
};
```

### 成本限制

```typescript
let sessionCost = 0;
const COST_LIMIT = 10.0;

agent.on('token_usage', (event) => {
  const cost = (event.inputTokens * 0.003 + event.outputTokens * 0.015) / 1000;
  sessionCost += cost;

  if (sessionCost > COST_LIMIT) {
    agent.interrupt();
  }
});
```

---

## 安全最佳实践

```typescript
// 文件 API 的路径边界；shell 执行仍使用宿主用户权限
const sandbox = new LocalSandbox({
  workDir: '/app/workspace',
  enforceBoundary: true,
  allowPaths: ['/app/workspace', '/tmp'],
});

// 权限配置
const agent = await Agent.create({
  templateId: 'secure-assistant',
  sandbox,
  overrides: {
    permission: {
      mode: 'auto',
      requireApprovalTools: ['bash_run', 'fs_write'],
      allowTools: ['fs_read', 'fs_glob', 'fs_write', 'bash_run'],
    },
  },
}, deps);

```

允许列表必须包含需审批的工具：不在列表中的工具会在请求审批前被拒绝。此配置允许读取，写文件或执行 shell 前请求审批。发送请求前需注册对应模板、工具和审批回调。LocalSandbox 不提供操作系统隔离；执行不可信代码应使用独立隔离的后端。

---

## 部署清单

- [ ] 生产环境使用 PostgreSQL
- [ ] 配置连接池
- [ ] 设置健康检查端点
- [ ] 配置指标收集
- [ ] 实现优雅关闭
- [ ] 使用环境变量存储密钥
- [ ] 启用数据库 SSL 连接
- [ ] 设置沙箱边界

---

## 部署模式

### 决策树

```
+------------------+
|    决策树        |
+------------------+
         |
         v
+----------------------+
| 单用户/本地机器？    |----是---> 模式 1: 单进程
+--------+-------------+
         | 否
         v
+----------------------+
| < 100 并发用户？     |----是---> 模式 2: 单服务器
+--------+-------------+
         | 否
         v
+----------------------+
| 可以运行长进程？     |----是---> 模式 3: Worker 微服务
+--------+-------------+
         | 否
         v
+----------------------+
| 只能 Serverless？    |----是---> 模式 4: 混合架构
+--------+-------------+
```

### 模式 1: 单进程（CLI/桌面）

**适用于：** CLI 工具、Electron 应用、VSCode 扩展

```typescript
import { Agent, AgentPool, JSONStore } from '@shareai-lab/kode-sdk';
import * as path from 'path';
import * as os from 'os';

const store = new JSONStore(path.join(os.homedir(), '.my-agent'));
const pool = new AgentPool({ dependencies: { store, ... } });

// 恢复或创建
const agent = pool.get('main') ?? await pool.create('main', { templateId: 'cli-assistant' });

// 交互循环
for await (const line of readline) {
  await agent.send(line);
  for await (const env of agent.subscribe(['progress'])) {
    if (env.event.type === 'text_chunk') process.stdout.write(env.event.delta);
    if (env.event.type === 'done') break;
  }
}
```

### 模式 2: 单服务器

**适用于：** 内部工具、小型团队（<100 并发用户）

```typescript
import { Hono } from 'hono';
import { AgentPool, SqliteStore } from '@shareai-lab/kode-sdk';

const app = new Hono();
const store = new SqliteStore('./agents.db', './data');
const pool = new AgentPool({ dependencies: { store, ... }, maxAgents: 50 });

app.post('/api/agents/:id/message', async (c) => {
  const { id } = c.req.param();
  const { message } = await c.req.json();

  let agent = pool.get(id);
  if (!agent) {
    const exists = await store.exists(id);
    agent = exists
      ? await pool.resume(id, getConfig())
      : await pool.create(id, getConfig());
  }

  return c.json(await agent.complete(message));
});
```

### 模式 3: Worker 微服务

**适用于：** 生产 SaaS、1000+ 并发用户

```
┌─────────────────────────────────────────────────────────────────┐
│                        负载均衡器                               │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
│   API 服务器 1  │ │   API 服务器 2  │ │   API 服务器 N  │
│   (无状态)      │ │   (无状态)      │ │   (无状态)      │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                    ┌────────▼────────┐
                    │   任务队列      │
                    │   (BullMQ)      │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
│   Worker 1      │ │   Worker 2      │ │   Worker N      │
│  AgentPool(50)  │ │  AgentPool(50)  │ │  AgentPool(50)  │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

详细实现请参阅英文文档 [Production Deployment](../../en/advanced/production.md)。

---

## 扩展策略

### 策略 1: 垂直扩展

**适用于：** 每进程 ~100 个并发 Agent

```typescript
const pool = new AgentPool({
  maxAgents: 100,  // 从默认 50 增加
  store: new SqliteStore('./agents.db', './data'),
});
```

### 策略 2: Agent 分片

**适用于：** 100-1000 个并发 Agent

使用一致性哈希将 Agent 路由到特定 Worker。

### 策略 3: LRU 调度

**适用于：** 1000+ 总 Agent，但同时活跃数量有限

```typescript
class AgentScheduler {
  private active: LRUCache<string, Agent>;

  async get(agentId: string): Promise<Agent> {
    if (this.active.has(agentId)) {
      return this.active.get(agentId)!;
    }
    // 从存储恢复
    const agent = await Agent.resume(agentId, config, deps);
    this.active.set(agentId, agent);  // LRU 淘汰处理休眠
    return agent;
  }
}
```

---

## 容量规划

| 部署方式 | Agent/进程 | 内存/Agent | 并发用户 |
|----------|------------|------------|----------|
| CLI | 1 | 10-100 MB | 1 |
| 桌面应用 | 5-10 | 50-200 MB | 1 |
| 单服务器 | 50 | 2-10 MB | 50-100 |
| Worker 集群 (10 节点) | 500 | 2-10 MB | 500-1000 |
| Worker 集群 (50 节点) | 2500 | 2-10 MB | 2500-5000 |

**每个 Agent 内存估算：**
- 基础对象：~50 KB
- 消息历史 (100 条消息)：~500 KB - 5 MB
- 工具调用记录：~50-500 KB
- 事件时间线：~100 KB - 1 MB
- **典型总计：1-10 MB**

---

## 参考资料

- [架构指南](./architecture.md)
- [数据库指南](../guides/database.md)
- [错误处理](../guides/error-handling.md)
- [事件指南](../guides/events.md)
