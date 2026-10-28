# 数据库持久化指南

KODE SDK 支持 SQLite 和 PostgreSQL 作为持久化后端，提供高性能的查询、聚合和分析能力。

---

## 支持的后端

| 后端 | 使用场景 | 特性 |
|------|----------|------|
| SQLite | 开发、单实例 | 零配置、文件存储 |
| PostgreSQL | 生产、多实例 | 并发写入、JSONB 查询 |

---

## 环境变量配置

Store 工厂需要显式配置对象，不会自动读取 `KODE_STORE_TYPE` 选择后端。下面变量由应用读取并映射到配置。SQLite/PostgreSQL Store 仍使用文件目录存放事件、Todo、历史与媒体；仅更换数据库并不代表所有状态已经分布式共享。


<!-- tabs:start -->
#### **Linux / macOS**
```bash
# SQLite
export KODE_STORE_TYPE=sqlite
export KODE_SQLITE_PATH=./data/agents.db
export KODE_STORE_PATH=./data/store

# PostgreSQL
export KODE_STORE_TYPE=postgres
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=kode_agents
export POSTGRES_USER=kode
export POSTGRES_PASSWORD=your_password
```

#### **Windows (PowerShell)**
```powershell
# SQLite
$env:KODE_STORE_TYPE="sqlite"
$env:KODE_SQLITE_PATH="./data/agents.db"
$env:KODE_STORE_PATH="./data/store"

# PostgreSQL
$env:KODE_STORE_TYPE="postgres"
$env:POSTGRES_HOST="localhost"
$env:POSTGRES_PORT="5432"
$env:POSTGRES_DB="kode_agents"
$env:POSTGRES_USER="kode"
$env:POSTGRES_PASSWORD="your_password"
```

#### **Windows (CMD)**
```cmd
set KODE_STORE_TYPE=sqlite
set KODE_SQLITE_PATH=./data/agents.db
set KODE_STORE_PATH=./data/store
```
<!-- tabs:end -->

---

## 快速开始

### 使用工厂函数（推荐）

```typescript
import { mkdirSync } from 'node:fs';
import { createExtendedStore } from '@shareai-lab/kode-sdk';

mkdirSync('./data', { recursive: true });

// 或显式指定后端
const sqliteStore = createExtendedStore({
  type: 'sqlite',
  dbPath: './data/agents.db',
  fileStoreBaseDir: './data/store',
});

const postgresStore = createExtendedStore({
  type: 'postgres',
  connection: {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432'),
    database: process.env.POSTGRES_DB ?? 'kode_agents',
    user: process.env.POSTGRES_USER ?? 'kode',
    password: process.env.POSTGRES_PASSWORD!,
  },
  fileStoreBaseDir: './data/store',
});
```

### 直接使用类

```typescript
import { SqliteStore, PostgresStore } from '@shareai-lab/kode-sdk';

// SQLite
const sqliteStore = new SqliteStore('./data/agents.db', './data/store');

// PostgreSQL
const postgresStore = new PostgresStore(
  {
    host: 'localhost',
    port: 5432,
    database: 'kode_agents',
    user: 'kode',
    password: 'password',
  },
  './data/store'
);
```

### 与 Agent 配合使用

```typescript
import { mkdirSync } from 'node:fs';
import {
  Agent, AnthropicProvider, AgentTemplateRegistry, ToolRegistry,
  SandboxFactory, LocalSandbox, createExtendedStore,
} from '@shareai-lab/kode-sdk';

mkdirSync('./data', { recursive: true });
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY');
const provider = new AnthropicProvider(apiKey, process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-5-20250929', process.env.ANTHROPIC_BASE_URL);
const store = createExtendedStore({ type: 'sqlite', dbPath: './data/agents.db', fileStoreBaseDir: './data/store' });
const templates = new AgentTemplateRegistry();
templates.register({ id: 'assistant', systemPrompt: 'You are a helpful assistant.' });
const sandbox = new LocalSandbox({ workDir: './workspace', watchFiles: false });
try {
  const agent = await Agent.create(
    { templateId: 'assistant', model: provider, sandbox },
    { store, templateRegistry: templates, toolRegistry: new ToolRegistry(), sandboxFactory: new SandboxFactory() }
  );
  const reply = await agent.chat('Hello!');
  console.log(reply.text);
} finally {
  try { await sandbox.dispose(); } finally { await store.close(); }
}
```

---

## 查询 API

### 会话查询：`querySessions()`

查询 Agent 会话列表，支持过滤和分页。

```typescript
import type { SessionFilters } from '@shareai-lab/kode-sdk';

const sessions = await store.querySessions({
  templateId: 'chat-assistant',
  startDate: Date.parse('2025-01-01'),
  limit: 20,
});

sessions.forEach(session => {
  console.log({
    agentId: session.agentId,
    templateId: session.templateId,
    createdAt: session.createdAt,
    messageCount: session.messageCount,
  });
});
```

### 消息查询：`queryMessages()`

查询消息记录，支持按角色和毫秒时间戳过滤。

```typescript
import type { MessageFilters } from '@shareai-lab/kode-sdk';

const messages = await store.queryMessages({
  agentId: 'agt-abc123',
  role: 'assistant',
  limit: 50,
});
```

### 工具调用查询：`queryToolCalls()`

查询工具调用记录，支持按工具名称和执行状态过滤。

```typescript
import type { ToolCallFilters } from '@shareai-lab/kode-sdk';

const toolCalls = await store.queryToolCalls({
  toolName: 'bash_run',
  state: 'FAILED',
  limit: 10,
});

toolCalls.forEach(call => {
  console.log({
    toolCallId: call.id,
    toolName: call.name,
    input: call.input,
    output: call.result,
    isError: call.isError,
    approval: call.approval,
  });
});
```

### 统计聚合：`aggregateStats()`

聚合统计 Agent 的消息数量和工具调用指标。

```typescript
const stats = await store.aggregateStats('agt-abc123');

console.log({
  totalMessages: stats.totalMessages,
  totalToolCalls: stats.totalToolCalls,
  totalSnapshots: stats.totalSnapshots,
  toolCallsByState: stats.toolCallsByState,  // { COMPLETED: 10, FAILED: 2, ... }
});

// 使用 toolCallsByState 计算成功率
if (stats.toolCallsByState) {
  const completed = stats.toolCallsByState['COMPLETED'] || 0;
  const successRate = (stats.totalToolCalls ? completed / stats.totalToolCalls * 100 : 0).toFixed(2);
  console.log(`工具调用成功率: ${successRate}%`);
}
```

---

## SQLite vs PostgreSQL

### 对比

| 特性 | SQLite | PostgreSQL |
|------|--------|------------|
| **部署** | 单文件，零配置 | 需要数据库服务器 |
| **并发写入** | 单进程 | 多进程 |
| **查询性能** | 适合小数据集 | 大数据集优化 |
| **JSON 支持** | JSON 函数 | JSONB + GIN 索引 |
| **备份** | 复制文件 | pg_dump/restore |
| **扩展性** | 单机 | 主从复制、分片 |

### 选择 SQLite 当...

- 单实例部署
- Agent 数量 < 1000
- 每日消息量 < 10 万条
- 快速原型开发
- 零运维成本需求

### 选择 PostgreSQL 当...

- 多实例部署
- Agent 数量 > 1000
- 每日消息量 > 10 万条
- 复杂查询和分析需求
- 高可用要求

---

## Docker 快速启动

### PostgreSQL

```bash
# 开发环境
docker run --name kode-postgres \
  -e POSTGRES_PASSWORD=kode123 \
  -e POSTGRES_DB=kode_agents \
  -p 5432:5432 \
  -d postgres:16-alpine

# 生产环境（持久化数据）
docker run --name kode-postgres \
  -e POSTGRES_PASSWORD=kode123 \
  -e POSTGRES_DB=kode_agents \
  -v /data/postgres:/var/lib/postgresql/data \
  -p 5432:5432 \
  -d postgres:16-alpine
```

---

## 性能优化

### 使用分页

```typescript
// 避免一次加载所有数据
const PAGE_SIZE = 100;
let offset = 0;

while (true) {
  const messages = await store.queryMessages({
    agentId,
    limit: PAGE_SIZE,
    offset,
  });

  if (messages.length === 0) break;
  processMessages(messages);
  offset += PAGE_SIZE;
}
```

### 使用时间过滤

```typescript
// 限制到最近数据
const messages = await store.queryMessages({
  agentId,
  startDate: Date.now() - 7 * 24 * 60 * 60 * 1000, // 最近 7 天
});
```

### PostgreSQL 连接池配置

```typescript
const store = createExtendedStore({
  type: 'postgres',
  connection: {
    host: 'localhost',
    port: 5432,
    database: 'kode_agents',
    user: 'kode',
    password: 'password',
    max: 20,                    // 最大连接数
    idleTimeoutMillis: 30000,   // 空闲连接超时
    connectionTimeoutMillis: 2000,
  },
  fileStoreBaseDir: './data/store',
});
```

---

## 备份

### SQLite

```bash
# 在线备份（推荐）
sqlite3 agents.db ".backup agents.db.backup"

# 导出 SQL
sqlite3 agents.db .dump > agents.sql
```

### PostgreSQL

```bash
# 逻辑备份
pg_dump -h localhost -U kode -d kode_agents > backup.sql

# 压缩备份
pg_dump -h localhost -U kode -d kode_agents | gzip > backup.sql.gz

# 定时备份（cron）
0 2 * * * pg_dump -h localhost -U kode -d kode_agents | gzip > /backup/kode_$(date +\%Y\%m\%d).sql.gz
```

---

## 故障排查

### SQLite：数据库锁定

```
Error: SQLITE_BUSY: database is locked
```

**解决方案**：启用 WAL 模式

```typescript
const db = new Database('./agents.db');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
```

### PostgreSQL：连接被拒绝

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**检查清单**：
1. 检查 PostgreSQL 是否运行：`pg_isready -h localhost -p 5432`
2. 检查防火墙设置
3. 验证 `pg_hba.conf` 允许连接
4. 验证 postgresql.conf 中 `listen_addresses = '*'`

### PostgreSQL：连接数过多

```
Error: sorry, too many clients already
```

**解决方案**：优化连接池

```typescript
const store = createExtendedStore({
  type: 'postgres',
  connection: {
    ...config,
    max: 10,                    // 减少单实例连接数
    idleTimeoutMillis: 10000,   // 更快释放空闲连接
  },
  fileStoreBaseDir: './data/store',
});
```

---

## 常见问题

**Q: 可以从 JSONStore 迁移到数据库吗？**

A: 可以，但目前需要手动迁移。未来版本会提供迁移工具。

**Q: 数据库存储会影响性能吗？**

A: 不会。对于常规操作（create、send、resume），性能与 JSONStore 相当。

**Q: 可以混用 SQLite 和 PostgreSQL 吗？**

A: 可以。`ExtendedStore` 接口抽象了底层实现：

```typescript
const store = process.env.NODE_ENV === 'production'
  ? createExtendedStore({ type: 'postgres', ... })
  : createExtendedStore({ type: 'sqlite', ... });
```

**Q: 如何删除旧数据？**

```typescript
// 删除指定 Agent
await store.delete(agentId);

// 批量删除旧 Agent
const sessions = await store.querySessions({
  endDate: Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 天前
});
for (const session of sessions) {
  await store.delete(session.agentId);
}
```

---

## 参考资料

- Store 接口：[API 参考](../reference/api.md#store)
