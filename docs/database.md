# 数据库持久化指南

KODE SDK 从 v2.7 开始支持 SQLite 和 PostgreSQL 作为持久化后端，提供高性能的查询、聚合和分析能力。本文档详细介绍数据库存储的架构设计、使用方法和最佳实践。

## 目录

- [为什么需要数据库？](#为什么需要数据库)
- [架构设计](#架构设计)
- [SQLite vs PostgreSQL](#sqlite-vs-postgresql)
- [快速开始](#快速开始)
- [查询 API 详解](#查询-api-详解)
- [性能优化](#性能优化)
- [生产部署](#生产部署)
- [故障排查](#故障排查)

---

## 为什么需要数据库？

默认的 `JSONStore` 适合单 Agent 快速开发，但在生产环境中存在以下限制：

| 场景 | JSONStore | 数据库存储 |
|------|-----------|------------|
| **查询会话列表** | 需要遍历所有目录 | 索引加速，毫秒级响应 |
| **统计工具调用次数** | 需要读取所有文件并聚合 | SQL 聚合函数，高效计算 |
| **按时间范围过滤** | 需要解析所有文件 | WHERE 条件过滤，索引优化 |
| **多进程并发** | 文件锁冲突风险 | 数据库事务保证一致性 |
| **备份与恢复** | 需要同步整个目录树 | 标准 SQL 工具（dump/restore）|
| **审计与合规** | 需要自定义日志分析 | SQL 查询生成审计报告 |

### 典型应用场景

1. **多 Agent 管理平台**：需要列出所有 Agent 会话、按模板分类、按时间排序
2. **工具调用分析**：统计哪些工具最常用、成功率如何、哪些 Agent 调用最多
3. **成本监控**：按 Agent、模板、时间维度统计 Token 用量和成本
4. **审计合规**：查询特定时间段内的所有工具调用记录、审批决策
5. **多实例部署**：多个服务实例共享同一个 PostgreSQL 数据库

---

## 架构设计

### 混合存储策略

KODE SDK 采用 **数据库 + 文件系统混合存储** 架构，在性能和灵活性之间取得平衡：

```
┌─────────────────────────────────────────────────────────┐
│                  QueryableStore                         │
│  (extends Store interface, 向后兼容)                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────┐     ┌────────────────────┐   │
│  │   Database          │     │   File System      │   │
│  │   (SQL)             │     │   (JSONStore)      │   │
│  ├─────────────────────┤     ├────────────────────┤   │
│  │ • AgentInfo         │     │ • Events           │   │
│  │ • Messages          │     │ • Todos            │   │
│  │ • ToolCallRecords   │     │ • History          │   │
│  │ • Snapshots         │     │ • Compression      │   │
│  └─────────────────────┘     └────────────────────┘   │
│         ↑ 查询优化                ↑ 高频写入             │
│         ↑ 聚合分析                ↑ 顺序访问             │
└─────────────────────────────────────────────────────────┘
```

### 数据分流原则

| 数据类型 | 存储位置 | 原因 |
|---------|---------|------|
| **AgentInfo** | 数据库 | 需要按 templateId、createdAt 查询和过滤 |
| **Messages** | 数据库 | 需要按 role、contentType、时间范围查询 |
| **ToolCallRecords** | 数据库 | 需要按 toolName、isError、hasApproval 查询和统计 |
| **Snapshots** | 数据库 | 需要列出所有快照、按时间排序 |
| **Events** | 文件系统 | 高频写入，仅需顺序追加和读取 |
| **Todos** | 文件系统 | 临时状态，频繁更新，无需查询 |
| **History** | 文件系统 | 上下文窗口历史，仅需完整读取 |
| **Compression** | 文件系统 | 压缩记录，仅需完整读取 |

### 表结构设计

#### SQLite 表结构

```sql
-- Agent 基础信息表
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  config_version TEXT,
  lineage TEXT,           -- JSON array
  message_count INTEGER DEFAULT 0,
  last_sfp_index INTEGER DEFAULT -1,
  breakpoint TEXT,
  last_bookmark TEXT      -- JSON object
);

-- 消息表
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,  -- JSON array
  metadata TEXT,          -- JSON object
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

-- 工具调用记录表
CREATE TABLE tool_call_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,    -- JSON object
  output TEXT,            -- JSON object
  is_error INTEGER DEFAULT 0,
  approval TEXT,          -- JSON object
  audit_trail TEXT,       -- JSON array
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

-- 快照表
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  parent_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  metadata TEXT,          -- JSON object
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);
```

#### PostgreSQL 表结构

PostgreSQL 版本使用 JSONB 类型优化 JSON 字段存储和查询：

```sql
-- Agent 基础信息表（使用 JSONB）
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  config_version TEXT,
  lineage JSONB,          -- JSONB array
  message_count INTEGER DEFAULT 0,
  last_sfp_index INTEGER DEFAULT -1,
  breakpoint TEXT,
  last_bookmark JSONB     -- JSONB object
);

-- 消息表（使用 JSONB）
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

-- 工具调用记录表（使用 JSONB）
CREATE TABLE tool_call_records (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input JSONB NOT NULL,
  output JSONB,
  is_error BOOLEAN DEFAULT FALSE,
  approval JSONB,
  audit_trail JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);

-- 快照表（使用 JSONB）
CREATE TABLE snapshots (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  parent_snapshot_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  metadata JSONB,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
);
```

#### 索引设计

```sql
-- SQLite 索引
CREATE INDEX idx_agents_template ON agents(template_id);
CREATE INDEX idx_agents_created ON agents(created_at);
CREATE INDEX idx_messages_agent_seq ON messages(agent_id, seq);
CREATE INDEX idx_messages_role ON messages(role);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE INDEX idx_tool_calls_agent ON tool_call_records(agent_id);
CREATE INDEX idx_tool_calls_name ON tool_call_records(tool_name);
CREATE INDEX idx_tool_calls_error ON tool_call_records(is_error);
CREATE INDEX idx_tool_calls_created ON tool_call_records(created_at);
CREATE INDEX idx_snapshots_agent ON snapshots(agent_id);

-- PostgreSQL 额外索引（利用 JSONB）
CREATE INDEX idx_agents_lineage ON agents USING GIN (lineage);
CREATE INDEX idx_messages_content ON messages USING GIN (content);
CREATE INDEX idx_tool_calls_input ON tool_call_records USING GIN (input);
CREATE INDEX idx_tool_calls_output ON tool_call_records USING GIN (output);
```

---

## SQLite vs PostgreSQL

### 对比矩阵

| 特性 | SQLite | PostgreSQL |
|-----|--------|-----------|
| **部署复杂度** | ⭐⭐⭐⭐⭐ 单文件，零配置 | ⭐⭐⭐ 需要数据库服务器 |
| **并发写入** | ⭐⭐⭐ 单进程写入 | ⭐⭐⭐⭐⭐ 多进程并发 |
| **查询性能** | ⭐⭐⭐⭐ 小数据集高效 | ⭐⭐⭐⭐⭐ 大数据集优化 |
| **JSON 支持** | ⭐⭐⭐ JSON 函数 | ⭐⭐⭐⭐⭐ JSONB + GIN 索引 |
| **备份恢复** | ⭐⭐⭐⭐⭐ 复制文件 | ⭐⭐⭐⭐ pg_dump/restore |
| **运维成本** | ⭐⭐⭐⭐⭐ 无需维护 | ⭐⭐⭐ 需要监控、备份、调优 |
| **扩展性** | ⭐⭐ 单机限制 | ⭐⭐⭐⭐⭐ 主从复制、分片 |
| **数据量上限** | ~100GB 推荐 | TB 级无压力 |

### 选择建议

#### 选择 SQLite 当...

- 单机部署，单个服务实例
- Agent 数量 < 1000
- 每日消息量 < 10 万条
- 需要快速开发和原型验证
- 希望零运维成本

**示例场景**：
- 个人开发和测试
- 小团队内部工具
- Edge 设备本地 Agent
- 单机爬虫/自动化脚本

#### 选择 PostgreSQL 当...

- 多实例部署，负载均衡
- Agent 数量 > 1000
- 每日消息量 > 10 万条
- 需要实时分析和复杂查询
- 需要跨地域备份和容灾

**示例场景**：
- 企业级 Agent 平台
- SaaS 多租户服务
- 数据分析和 BI 看板
- 审计合规要求严格的场景

---

## 快速开始

### 安装依赖

```bash
# SQLite（通常已内置）
npm install better-sqlite3

# PostgreSQL
npm install pg
```

### SQLite 示例

```typescript
import { Agent } from '@shareai-lab/kode-sdk';
import { SqliteStore } from '@shareai-lab/kode-sdk/infra/db/sqlite';
import path from 'path';

// 1. 创建 SQLite Store
const dbPath = path.join(__dirname, 'data', 'agents.db');
const storePath = path.join(__dirname, 'data', 'store');
const store = new SqliteStore(dbPath, storePath);

// 2. 创建 Agent
const agent = await Agent.create({
  provider,
  store,
  template: {
    id: 'my-template',
    systemPrompt: 'You are a helpful assistant.',
    tools: []
  }
});

// 3. 对话
await agent.send({ role: 'user', content: 'Hello!' });

// 4. 查询会话列表
const sessions = await store.querySessions({
  templateId: 'my-template',
  limit: 10
});
console.log(`Found ${sessions.length} sessions`);

// 5. 统计工具调用
const stats = await store.aggregateStats({ agentId: agent.id });
console.log(stats);

// 6. 关闭数据库
await store.close();
```

### PostgreSQL 示例

```typescript
import { Agent } from '@shareai-lab/kode-sdk';
import { PostgresStore } from '@shareai-lab/kode-sdk/infra/db/postgres';

// 1. 创建 PostgreSQL Store
const store = new PostgresStore(
  {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'kode_agents',
    user: process.env.POSTGRES_USER || 'kode',
    password: process.env.POSTGRES_PASSWORD
  },
  './data/store'
);

// 2-5. 使用方法与 SQLite 完全一致

// 6. 关闭连接池
await store.close();
```

### Docker 快速启动

#### PostgreSQL

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

## 查询 API 详解

### 会话查询：querySessions()

查询 Agent 会话列表，支持按模板、时间范围过滤和分页。

```typescript
interface SessionQueryFilter {
  templateId?: string;      // 按模板 ID 过滤
  createdAfter?: Date;      // 创建时间晚于
  createdBefore?: Date;     // 创建时间早于
  limit?: number;           // 返回数量限制（默认 100）
  offset?: number;          // 分页偏移量（默认 0）
}

const sessions = await store.querySessions({
  templateId: 'chat-assistant',
  createdAfter: new Date('2025-01-01'),
  limit: 20,
  offset: 0
});

// 返回结果
sessions.forEach(session => {
  console.log({
    agentId: session.agentId,
    templateId: session.templateId,
    createdAt: session.createdAt,
    messageCount: session.messageCount,
    lineage: session.lineage  // 父 Agent ID 链
  });
});
```

**典型用例**：
- 管理后台列出所有 Agent 会话
- 按模板分类展示不同类型的 Agent
- 时间范围过滤（今天、本周、本月）

### 消息查询：queryMessages()

查询消息记录，支持按 Agent、角色、内容类型过滤。

```typescript
interface MessageQueryFilter {
  agentId?: string;         // 按 Agent ID 过滤
  role?: 'user' | 'assistant';  // 按角色过滤
  contentType?: 'text' | 'tool_use' | 'tool_result';  // 按内容类型过滤
  createdAfter?: Date;      // 创建时间晚于
  createdBefore?: Date;     // 创建时间早于
  limit?: number;           // 返回数量限制（默认 100）
  offset?: number;          // 分页偏移量（默认 0）
}

const messages = await store.queryMessages({
  agentId: 'agt-abc123',
  role: 'assistant',
  contentType: 'tool_use',
  limit: 50
});

// 返回结果
messages.forEach(msg => {
  console.log({
    agentId: msg.agentId,
    seq: msg.seq,
    role: msg.role,
    content: msg.content,  // ContentBlock[]
    createdAt: msg.createdAt
  });
});
```

**典型用例**：
- 查看特定 Agent 的对话历史
- 分析 Assistant 生成的所有工具调用
- 提取用户输入用于训练和分析

### 工具调用查询：queryToolCalls()

查询工具调用记录，支持按工具名、错误状态、审批状态过滤。

```typescript
interface ToolCallQueryFilter {
  agentId?: string;         // 按 Agent ID 过滤
  toolName?: string;        // 按工具名称过滤
  isError?: boolean;        // 按错误状态过滤
  hasApproval?: boolean;    // 按审批状态过滤
  createdAfter?: Date;      // 创建时间晚于
  createdBefore?: Date;     // 创建时间早于
  limit?: number;           // 返回数量限制（默认 100）
  offset?: number;          // 分页偏移量（默认 0）
}

const toolCalls = await store.queryToolCalls({
  toolName: 'bash_run',
  isError: true,
  limit: 10
});

// 返回结果
toolCalls.forEach(call => {
  console.log({
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    output: call.output,
    isError: call.isError,
    approval: call.approval,  // ToolCallApproval | undefined
    auditTrail: call.auditTrail  // 审计日志
  });
});
```

**典型用例**：
- 统计哪些工具最常失败
- 查看所有需要审批的工具调用
- 生成工具使用审计报告

### 统计聚合：aggregateStats()

聚合统计 Agent 的消息数量、工具调用次数、成功率等指标。

```typescript
interface StatsQueryFilter {
  agentId: string;          // 必填：Agent ID
}

const stats = await store.aggregateStats({ agentId: 'agt-abc123' });

console.log({
  totalMessages: stats.totalMessages,           // 消息总数
  totalToolCalls: stats.totalToolCalls,         // 工具调用总数
  successfulToolCalls: stats.successfulToolCalls,  // 成功次数
  failedToolCalls: stats.failedToolCalls        // 失败次数
});

// 计算成功率
const successRate = (stats.successfulToolCalls / stats.totalToolCalls * 100).toFixed(2);
console.log(`Tool call success rate: ${successRate}%`);
```

**典型用例**：
- Agent 性能监控看板
- 工具可靠性分析
- 成本估算（基于消息数量）

---

## 性能优化

### 索引优化

默认索引已覆盖常见查询场景，但如果有特定查询模式，可以添加自定义索引：

```sql
-- 示例：按 Agent 和工具名组合查询
CREATE INDEX idx_tool_calls_agent_tool ON tool_call_records(agent_id, tool_name);

-- 示例：按消息内容类型查询（需要解析 JSON）
-- PostgreSQL JSONB 索引
CREATE INDEX idx_messages_content_type ON messages USING GIN ((content->0->>'type'));
```

### 查询优化

#### 1. 使用分页避免大结果集

```typescript
// 不推荐：一次性加载所有数据
const allMessages = await store.queryMessages({ agentId });

// 推荐：分页加载
const PAGE_SIZE = 100;
let offset = 0;
while (true) {
  const messages = await store.queryMessages({
    agentId,
    limit: PAGE_SIZE,
    offset
  });
  if (messages.length === 0) break;

  // 处理当前页
  processMessages(messages);
  offset += PAGE_SIZE;
}
```

#### 2. 使用时间范围过滤

```typescript
// 不推荐：查询所有历史数据
const messages = await store.queryMessages({ agentId });

// 推荐：限制时间范围
const messages = await store.queryMessages({
  agentId,
  createdAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)  // 最近 7 天
});
```

#### 3. 按需查询字段

数据库查询已经只返回必要字段，但可以进一步优化：

```typescript
// 如果只需要统计数量，不需要查询详细记录
const stats = await store.aggregateStats({ agentId });
// 比 queryMessages() 然后统计快得多
```

### 写入优化

#### 1. 批量插入（内部已实现）

Store 实现内部已使用事务批量插入：

```typescript
// saveMessages 内部实现
db.transaction(() => {
  for (const message of messages) {
    stmt.run(message);
  }
})();
```

#### 2. 延迟写入（高频场景）

对于高频写入场景（如实时流式输出），可以考虑缓冲后批量写入：

```typescript
class BufferedStore {
  private buffer: Message[] = [];
  private flushInterval = 5000;  // 5秒刷新一次

  constructor(private store: QueryableStore) {
    setInterval(() => this.flush(), this.flushInterval);
  }

  async saveMessage(agentId: string, message: Message) {
    this.buffer.push({ agentId, ...message });
    if (this.buffer.length >= 100) {
      await this.flush();
    }
  }

  private async flush() {
    if (this.buffer.length === 0) return;

    // 按 agentId 分组批量写入
    const grouped = groupBy(this.buffer, m => m.agentId);
    for (const [agentId, messages] of grouped) {
      await this.store.saveMessages(agentId, messages);
    }
    this.buffer = [];
  }
}
```

### PostgreSQL 特定优化

#### 1. 连接池配置

```typescript
const store = new PostgresStore(
  {
    host: 'localhost',
    port: 5432,
    database: 'kode_agents',
    user: 'kode',
    password: 'password',
    // 连接池配置
    max: 20,          // 最大连接数
    idleTimeoutMillis: 30000,  // 空闲连接超时
    connectionTimeoutMillis: 2000  // 连接超时
  },
  './data/store'
);
```

#### 2. JSONB 查询优化

利用 PostgreSQL 的 JSONB 操作符进行高效查询：

```sql
-- 查询包含特定工具调用的消息
SELECT * FROM messages
WHERE content @> '[{"type": "tool_use", "name": "bash_run"}]';

-- 查询工具输入包含特定参数的记录
SELECT * FROM tool_call_records
WHERE input @> '{"command": "ls"}';
```

---

## 生产部署

### 数据库初始化

Store 在首次创建时会自动初始化表结构和索引，无需手动执行 SQL 脚本。

```typescript
// 第一次运行会自动创建表
const store = new SqliteStore('./agents.db', './store');
// 或
const store = new PostgresStore(config, './store');
```

### 备份策略

#### SQLite 备份

```bash
# 方法 1：文件复制（需要先停止写入）
cp agents.db agents.db.backup

# 方法 2：在线备份（推荐）
sqlite3 agents.db ".backup agents.db.backup"

# 方法 3：导出 SQL
sqlite3 agents.db .dump > agents.sql
```

#### PostgreSQL 备份

```bash
# 逻辑备份（小数据库）
pg_dump -h localhost -U kode -d kode_agents > backup.sql

# 压缩备份
pg_dump -h localhost -U kode -d kode_agents | gzip > backup.sql.gz

# 物理备份（大数据库，需要 wal_level = replica）
pg_basebackup -h localhost -U kode -D /backup/postgres -Fp -Xs -P

# 定时备份（cron）
0 2 * * * pg_dump -h localhost -U kode -d kode_agents | gzip > /backup/kode_$(date +\%Y\%m\%d).sql.gz
```

### 监控指标

#### 关键指标

| 指标 | 说明 | 告警阈值 |
|-----|------|---------|
| **数据库文件大小** | SQLite 文件大小 | > 50GB 考虑迁移 |
| **连接数** | PostgreSQL 活跃连接 | > max_connections * 0.8 |
| **慢查询** | 执行时间 > 1s 的查询 | > 100 次/小时 |
| **锁等待** | 事务等待锁的时间 | > 100ms |
| **磁盘 I/O** | 读写吞吐量 | > 80% 利用率 |

#### SQLite 监控

```typescript
import Database from 'better-sqlite3';

const db = new Database('./agents.db');

// 查询数据库大小
const size = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get();
console.log(`Database size: ${(size.size / 1024 / 1024).toFixed(2)} MB`);

// 查询表行数
const counts = db.prepare('SELECT COUNT(*) as count FROM messages').get();
console.log(`Message count: ${counts.count}`);
```

#### PostgreSQL 监控

```sql
-- 数据库大小
SELECT pg_size_pretty(pg_database_size('kode_agents'));

-- 表大小
SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename))
FROM pg_tables WHERE schemaname = 'public';

-- 活跃连接数
SELECT count(*) FROM pg_stat_activity WHERE datname = 'kode_agents';

-- 慢查询（需要启用 pg_stat_statements）
SELECT query, calls, mean_exec_time, stddev_exec_time
FROM pg_stat_statements
WHERE mean_exec_time > 1000  -- > 1s
ORDER BY mean_exec_time DESC
LIMIT 10;

-- 锁等待
SELECT pid, usename, pg_blocking_pids(pid) as blocked_by, query
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

### 高可用部署

#### PostgreSQL 主从复制

```bash
# 主库配置（postgresql.conf）
wal_level = replica
max_wal_senders = 3
wal_keep_size = 64MB

# 从库启动
pg_basebackup -h master -U replication -D /data/postgres -Fp -Xs -P
# 配置 standby.signal 和 primary_conninfo

# 应用层连接池配置（读写分离）
const masterStore = new PostgresStore(masterConfig, './store');
const replicaStore = new PostgresStore(replicaConfig, './store');

// 写操作用主库
await masterStore.saveMessages(agentId, messages);

// 读操作用从库
const sessions = await replicaStore.querySessions({ limit: 10 });
```

#### 连接池管理（多实例）

```typescript
// 使用连接池单例模式避免重复连接
class PostgresStoreFactory {
  private static poolMap = new Map<string, Pool>();

  static create(config: PoolConfig, storePath: string): PostgresStore {
    const key = `${config.host}:${config.port}/${config.database}`;
    if (!this.poolMap.has(key)) {
      const pool = new Pool(config);
      this.poolMap.set(key, pool);
    }
    return new PostgresStore(config, storePath, this.poolMap.get(key));
  }
}

// 多个 Agent 共享同一个连接池
const store1 = PostgresStoreFactory.create(config, './store1');
const store2 = PostgresStoreFactory.create(config, './store2');
```

---

## 故障排查

### SQLite 常见问题

#### 问题 1：数据库锁定错误

```
Error: SQLITE_BUSY: database is locked
```

**原因**：多个进程同时写入 SQLite

**解决**：
1. 使用 WAL 模式（Write-Ahead Logging）：
```typescript
const db = new Database('./agents.db');
db.pragma('journal_mode = WAL');
```

2. 增加 busy timeout：
```typescript
db.pragma('busy_timeout = 5000');  // 5秒
```

3. 考虑迁移到 PostgreSQL（多实例场景）

#### 问题 2：数据库文件损坏

```
Error: database disk image is malformed
```

**解决**：
```bash
# 尝试恢复
sqlite3 agents.db "PRAGMA integrity_check"

# 如果失败，从备份恢复
cp agents.db.backup agents.db

# 或导出导入
sqlite3 agents.db .dump > dump.sql
sqlite3 agents_new.db < dump.sql
```

### PostgreSQL 常见问题

#### 问题 1：连接被拒绝

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**排查步骤**：
```bash
# 1. 检查 PostgreSQL 是否运行
pg_isready -h localhost -p 5432

# 2. 检查防火墙
sudo ufw status
sudo ufw allow 5432/tcp

# 3. 检查 pg_hba.conf
# 确保允许来自应用服务器的连接
host    all    all    0.0.0.0/0    md5

# 4. 检查 postgresql.conf
listen_addresses = '*'
```

#### 问题 2：连接池耗尽

```
Error: sorry, too many clients already
```

**解决**：
1. 增加 PostgreSQL max_connections：
```sql
ALTER SYSTEM SET max_connections = 200;
SELECT pg_reload_conf();
```

2. 优化应用连接池：
```typescript
const store = new PostgresStore({
  ...config,
  max: 10,  // 减少单实例连接数
  idleTimeoutMillis: 10000  // 更快释放空闲连接
}, storePath);
```

#### 问题 3：慢查询

**排查步骤**：
```sql
-- 1. 启用慢查询日志
ALTER SYSTEM SET log_min_duration_statement = 1000;  -- 1s
SELECT pg_reload_conf();

-- 2. 查看执行计划
EXPLAIN ANALYZE
SELECT * FROM messages WHERE agent_id = 'agt-abc123' ORDER BY seq;

-- 3. 检查索引使用
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE schemaname = 'public';

-- 4. 分析表统计信息
ANALYZE messages;
```

### 数据一致性问题

#### 问题：数据库与文件系统不一致

**原因**：事务失败或进程异常退出导致部分数据未写入

**排查**：
```typescript
// 检查 AgentInfo 是否存在
const exists = await store.exists(agentId);
const info = await store.loadInfo(agentId);

// 检查文件系统数据是否存在
const eventsExist = fs.existsSync(`./store/${agentId}/events.jsonl`);

console.log({ exists, info, eventsExist });
```

**解决**：
```typescript
// 方法 1：从数据库恢复（如果数据库完整）
const info = await store.loadInfo(agentId);
const messages = await store.loadMessages(agentId);
// 手动重建文件系统数据...

// 方法 2：从备份恢复
await store.delete(agentId);
// 从备份文件恢复...
```

---

## 常见问题 (FAQ)

### Q: 可以从 JSONStore 迁移到数据库存储吗？

A: 可以，但目前需要手动迁移。未来版本会提供迁移工具。手动迁移步骤：

```typescript
// 1. 读取 JSONStore 数据
const jsonStore = new JSONStore('./old-store');
const agentIds = await jsonStore.list('agt-');

// 2. 逐个迁移到数据库
const dbStore = new SqliteStore('./agents.db', './new-store');
for (const agentId of agentIds) {
  const info = await jsonStore.loadInfo(agentId);
  const messages = await jsonStore.loadMessages(agentId);
  const toolCalls = await jsonStore.loadToolCallRecords(agentId);
  const snapshots = await jsonStore.listSnapshots(agentId);

  await dbStore.saveInfo(agentId, info);
  await dbStore.saveMessages(agentId, messages);
  await dbStore.saveToolCallRecords(agentId, toolCalls);
  for (const snapshot of snapshots) {
    await dbStore.saveSnapshot(agentId, snapshot);
  }
}
```

### Q: 数据库存储会影响性能吗？

A: 不会。对于常规操作（create、send、resume），性能与 JSONStore 相当。数据库带来的额外开销主要在查询和聚合操作上，但这些操作在 JSONStore 中更慢或无法实现。

### Q: 可以混用 SQLite 和 PostgreSQL 吗？

A: 可以。`QueryableStore` 接口抽象了底层实现，你可以在不同环境使用不同的 Store：

```typescript
const store = process.env.NODE_ENV === 'production'
  ? new PostgresStore(pgConfig, storePath)
  : new SqliteStore('./dev.db', storePath);
```

### Q: 数据库文件可以跨平台使用吗？

A: SQLite 文件在不同操作系统和架构之间是兼容的，可以直接复制使用。PostgreSQL 备份（pg_dump）也是跨平台的。

### Q: 如何删除旧数据释放空间？

A:

```typescript
// 删除指定 Agent
await store.delete(agentId);

// 批量删除旧 Agent（自定义逻辑）
const sessions = await store.querySessions({
  createdBefore: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)  // 90 天前
});
for (const session of sessions) {
  await store.delete(session.agentId);
}

// SQLite vacuum 释放空间
// （需要直接操作数据库）
const db = new Database('./agents.db');
db.exec('VACUUM');
```

---

## 下一步

- 查看示例代码：[`examples/db-sqlite.ts`](../examples/db-sqlite.ts)、[`examples/db-postgres.ts`](../examples/db-postgres.ts)
- 了解 Store 接口设计：[`docs/api.md#store`](./api.md#store)
- 提交问题和建议：[GitHub Issues](https://github.com/shareai-lab/kode-sdk/issues)
