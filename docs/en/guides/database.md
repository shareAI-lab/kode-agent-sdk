# Database Persistence Guide

KODE SDK supports SQLite and PostgreSQL as persistence backends, providing high-performance querying, aggregation, and analysis capabilities.

---

## Supported Backends

| Backend | Use Case | Features |
|---------|----------|----------|
| SQLite | Development, Single Instance | Zero config, file-based |
| PostgreSQL | Production, Multi-Instance | Concurrent writes, JSONB queries |

---

## Environment Variables

Store factories require an explicit configuration object; the SDK does not auto-select a backend from `KODE_STORE_TYPE`. The variables below are application inputs to map into that object. The SQLite/PostgreSQL stores also use a fileStore directory for events, Todo, history and media; a database alone does not make these stores fully distributed.


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

## Quick Start

### Using Factory Function (Recommended)

```typescript
import { mkdirSync } from 'node:fs';
import { createExtendedStore } from '@shareai-lab/kode-sdk';

mkdirSync('./data', { recursive: true });

// Or specify backend explicitly
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

### Direct Class Usage

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

### Using with Agent

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

## Query APIs

### Query Sessions: `querySessions()`

Query Agent session list with filtering and pagination.

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

### Query Messages: `queryMessages()`

Query message records with filtering by role and timestamp.

```typescript
import type { MessageFilters } from '@shareai-lab/kode-sdk';

const messages = await store.queryMessages({
  agentId: 'agt-abc123',
  role: 'assistant',
  limit: 50,
});
```

### Query Tool Calls: `queryToolCalls()`

Query tool call records with filtering by tool name and execution state.

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

### Aggregate Stats: `aggregateStats()`

Aggregate statistics for an Agent including message counts and tool call metrics.

```typescript
const stats = await store.aggregateStats('agt-abc123');

console.log({
  totalMessages: stats.totalMessages,
  totalToolCalls: stats.totalToolCalls,
  totalSnapshots: stats.totalSnapshots,
  toolCallsByState: stats.toolCallsByState,  // { COMPLETED: 10, FAILED: 2, ... }
});

// Calculate success rate using toolCallsByState
if (stats.toolCallsByState) {
  const completed = stats.toolCallsByState['COMPLETED'] || 0;
  const successRate = (stats.totalToolCalls ? completed / stats.totalToolCalls * 100 : 0).toFixed(2);
  console.log(`Tool call success rate: ${successRate}%`);
}
```

---

## SQLite vs PostgreSQL

### Comparison

| Feature | SQLite | PostgreSQL |
|---------|--------|------------|
| **Deployment** | Single file, zero config | Requires database server |
| **Concurrent Writes** | Single process | Multi-process |
| **Query Performance** | Good for small datasets | Optimized for large datasets |
| **JSON Support** | JSON functions | JSONB + GIN indexes |
| **Backup** | Copy file | pg_dump/restore |
| **Scaling** | Single machine | Replication, sharding |

### When to Choose SQLite

- Single instance deployment
- Less than 1000 Agents
- Less than 100K messages per day
- Quick prototyping
- Zero maintenance overhead

### When to Choose PostgreSQL

- Multi-instance deployment
- More than 1000 Agents
- More than 100K messages per day
- Complex queries and analytics
- High availability requirements

---

## Docker Quick Start

### PostgreSQL

```bash
# Development
docker run --name kode-postgres \
  -e POSTGRES_PASSWORD=kode123 \
  -e POSTGRES_DB=kode_agents \
  -p 5432:5432 \
  -d postgres:16-alpine

# Production (persistent data)
docker run --name kode-postgres \
  -e POSTGRES_PASSWORD=kode123 \
  -e POSTGRES_DB=kode_agents \
  -v /data/postgres:/var/lib/postgresql/data \
  -p 5432:5432 \
  -d postgres:16-alpine
```

---

## Performance Tips

### Use Pagination

```typescript
// Avoid loading all data at once
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

### Use Time Filters

```typescript
// Limit to recent data
const messages = await store.queryMessages({
  agentId,
  startDate: Date.now() - 7 * 24 * 60 * 60 * 1000, // Last 7 days
});
```

### PostgreSQL Connection Pool

```typescript
const store = createExtendedStore({
  type: 'postgres',
  connection: {
    host: 'localhost',
    port: 5432,
    database: 'kode_agents',
    user: 'kode',
    password: 'password',
    max: 20,                    // Max connections
    idleTimeoutMillis: 30000,   // Idle connection timeout
    connectionTimeoutMillis: 2000,
  },
  fileStoreBaseDir: './data/store',
});
```

---

## Backup

### SQLite

```bash
# Online backup (recommended)
sqlite3 agents.db ".backup agents.db.backup"

# Export SQL
sqlite3 agents.db .dump > agents.sql
```

### PostgreSQL

```bash
# Logical backup
pg_dump -h localhost -U kode -d kode_agents > backup.sql

# Compressed backup
pg_dump -h localhost -U kode -d kode_agents | gzip > backup.sql.gz

# Scheduled backup (cron)
0 2 * * * pg_dump -h localhost -U kode -d kode_agents | gzip > /backup/kode_$(date +\%Y\%m\%d).sql.gz
```

---

## Troubleshooting

### SQLite: Database Locked

```
Error: SQLITE_BUSY: database is locked
```

**Solution**: Enable WAL mode

```typescript
const db = new Database('./agents.db');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
```

### PostgreSQL: Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Checklist**:
1. Check if PostgreSQL is running: `pg_isready -h localhost -p 5432`
2. Check firewall settings
3. Verify `pg_hba.conf` allows connections
4. Verify `listen_addresses = '*'` in postgresql.conf

### PostgreSQL: Too Many Clients

```
Error: sorry, too many clients already
```

**Solution**: Optimize connection pool

```typescript
const store = createExtendedStore({
  type: 'postgres',
  connection: {
    ...config,
    max: 10,                    // Reduce per-instance connections
    idleTimeoutMillis: 10000,   // Release idle connections faster
  },
  fileStoreBaseDir: './data/store',
});
```

---

## FAQ

**Q: Can I migrate from JSONStore to database?**

A: Yes, manual migration is required. A migration tool will be provided in future versions.

**Q: Does database storage affect performance?**

A: No. For regular operations (create, send, resume), performance is comparable to JSONStore.

**Q: Can I mix SQLite and PostgreSQL?**

A: Yes. The `ExtendedStore` interface abstracts the underlying implementation:

```typescript
const store = process.env.NODE_ENV === 'production'
  ? createExtendedStore({ type: 'postgres', ... })
  : createExtendedStore({ type: 'sqlite', ... });
```

**Q: How to delete old data?**

```typescript
// Delete specific Agent
await store.delete(agentId);

// Batch delete old Agents
const sessions = await store.querySessions({
  endDate: Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 days ago
});
for (const session of sessions) {
  await store.delete(session.agentId);
}
```

---

## References

- Store interface: [API Reference](../reference/api.md#store)

---

## Custom Store Implementation

If you need a different database backend (MongoDB, DynamoDB, etc.), you can implement the `Store` interface.

### Store Interface Overview

The Store interface has three layers:

```
Store (base)
  └── QueryableStore (adds query methods)
        └── ExtendedStore (adds health check, metrics, distributed lock)
```

**Basic Store** (required methods):

```typescript
interface Store {
  // Runtime State
  saveMessages(agentId: string, messages: Message[]): Promise<void>;
  loadMessages(agentId: string): Promise<Message[]>;
  saveToolCallRecords(agentId: string, records: ToolCallRecord[]): Promise<void>;
  loadToolCallRecords(agentId: string): Promise<ToolCallRecord[]>;
  saveTodos(agentId: string, snapshot: TodoSnapshot): Promise<void>;
  loadTodos(agentId: string): Promise<TodoSnapshot | undefined>;

  // Events
  appendEvent(agentId: string, timeline: Timeline): Promise<void>;
  readEvents(agentId: string, opts?: { since?: Bookmark; channel?: AgentChannel }): AsyncIterable<Timeline>;

  // History & Compression
  saveHistoryWindow(agentId: string, window: HistoryWindow): Promise<void>;
  loadHistoryWindows(agentId: string): Promise<HistoryWindow[]>;
  saveCompressionRecord(agentId: string, record: CompressionRecord): Promise<void>;
  loadCompressionRecords(agentId: string): Promise<CompressionRecord[]>;
  saveRecoveredFile(agentId: string, file: RecoveredFile): Promise<void>;
  loadRecoveredFiles(agentId: string): Promise<RecoveredFile[]>;

  // Multimodal Cache
  saveMediaCache(agentId: string, records: MediaCacheRecord[]): Promise<void>;
  loadMediaCache(agentId: string): Promise<MediaCacheRecord[]>;

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

### Minimal Custom Store Example

```typescript
import {
  Store,
  Message,
  ToolCallRecord,
  Timeline,
  Snapshot,
  AgentInfo,
  TodoSnapshot,
  HistoryWindow,
  CompressionRecord,
  RecoveredFile,
  MediaCacheRecord,
  Bookmark,
  AgentChannel,
} from '@shareai-lab/kode-sdk';
import { MongoClient, Collection } from 'mongodb';

export class MongoStore implements Store {
  private db: Db;
  private agents: Collection;
  private messages: Collection;
  private events: Collection;

  constructor(private client: MongoClient, dbName: string) {
    this.db = client.db(dbName);
    this.agents = this.db.collection('agents');
    this.messages = this.db.collection('messages');
    this.events = this.db.collection('events');
  }

  // === Runtime State ===

  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    await this.messages.updateOne(
      { agentId },
      { $set: { agentId, messages, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async loadMessages(agentId: string): Promise<Message[]> {
    const doc = await this.messages.findOne({ agentId });
    return doc?.messages || [];
  }

  async saveToolCallRecords(agentId: string, records: ToolCallRecord[]): Promise<void> {
    await this.db.collection('tool_calls').updateOne(
      { agentId },
      { $set: { agentId, records, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async loadToolCallRecords(agentId: string): Promise<ToolCallRecord[]> {
    const doc = await this.db.collection('tool_calls').findOne({ agentId });
    return doc?.records || [];
  }

  // === Events ===

  async appendEvent(agentId: string, timeline: Timeline): Promise<void> {
    await this.events.insertOne({
      agentId,
      cursor: timeline.cursor,
      bookmark: timeline.bookmark,
      event: timeline.event,
      createdAt: new Date(),
    });
  }

  async *readEvents(agentId: string, opts?: { since?: Bookmark; channel?: AgentChannel }): AsyncIterable<Timeline> {
    const query: any = { agentId };
    if (opts?.since) {
      query['bookmark.seq'] = { $gt: opts.since.seq };
    }
    if (opts?.channel) {
      query['event.channel'] = opts.channel;
    }

    const cursor = this.events.find(query).sort({ 'bookmark.seq': 1 });
    for await (const doc of cursor) {
      yield {
        cursor: doc.cursor,
        bookmark: doc.bookmark,
        event: doc.event,
      };
    }
  }

  // === Metadata ===

  async saveInfo(agentId: string, info: AgentInfo): Promise<void> {
    await this.agents.updateOne(
      { agentId },
      { $set: { ...info, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async loadInfo(agentId: string): Promise<AgentInfo | undefined> {
    const doc = await this.agents.findOne({ agentId });
    if (!doc) return undefined;
    return {
      agentId: doc.agentId,
      templateId: doc.templateId,
      createdAt: doc.createdAt,
      lineage: doc.lineage,
      configVersion: doc.configVersion,
      messageCount: doc.messageCount,
      lastSfpIndex: doc.lastSfpIndex,
      lastBookmark: doc.lastBookmark,
      breakpoint: doc.breakpoint,
      metadata: doc.metadata,
    };
  }

  // === Lifecycle ===

  async exists(agentId: string): Promise<boolean> {
    const count = await this.agents.countDocuments({ agentId });
    return count > 0;
  }

  async delete(agentId: string): Promise<void> {
    await Promise.all([
      this.agents.deleteOne({ agentId }),
      this.messages.deleteOne({ agentId }),
      this.events.deleteMany({ agentId }),
      this.db.collection('tool_calls').deleteOne({ agentId }),
      this.db.collection('snapshots').deleteMany({ agentId }),
      // ... delete other collections
    ]);
  }

  async list(prefix?: string): Promise<string[]> {
    const query = prefix ? { agentId: { $regex: `^${prefix}` } } : {};
    const docs = await this.agents.find(query, { projection: { agentId: 1 } }).toArray();
    return docs.map(d => d.agentId);
  }

  // ... implement remaining methods (snapshots, history, compression, media cache, todos)
}
```

### Hybrid Storage Pattern

For high-performance scenarios, use a hybrid approach like `PostgresStore`:

```
┌─────────────────────────────────────────────────────┐
│                   Your Custom Store                  │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Database (for queryable data):       File System:   │
│  ┌─────────────────────────┐    ┌──────────────────┐│
│  │ AgentInfo               │    │ Events (append)  ││
│  │ Messages                │    │ Todos            ││
│  │ ToolCallRecords         │    │ History Windows  ││
│  │ Snapshots               │    │ Media Cache      ││
│  └─────────────────────────┘    └──────────────────┘│
│                                                      │
└─────────────────────────────────────────────────────┘
```

**Why hybrid?**
- Database: Supports queries, indexes, transactions
- File System: Better for high-frequency append operations (events)

```typescript
export class HybridStore implements ExtendedStore {
  private db: Database;           // Your database client
  private fileStore: JSONStore;   // Delegate file operations

  constructor(dbConfig: any, fileDir: string) {
    this.db = new Database(dbConfig);
    this.fileStore = new JSONStore(fileDir);
  }

  // Database operations
  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    await this.db.query('INSERT INTO messages ...');
  }

  // Delegate to JSONStore for events
  async appendEvent(agentId: string, timeline: Timeline): Promise<void> {
    return this.fileStore.appendEvent(agentId, timeline);
  }

  async *readEvents(agentId: string, opts?: any): AsyncIterable<Timeline> {
    yield* this.fileStore.readEvents(agentId, opts);
  }
}
```

### Testing Your Store

```typescript
import { describe, it, expect } from 'vitest';
import { MongoStore } from './mongo-store';

describe('MongoStore', () => {
  let store: MongoStore;

  beforeAll(async () => {
    const client = await MongoClient.connect('mongodb://localhost:27017');
    store = new MongoStore(client, 'kode_test');
  });

  it('should save and load messages', async () => {
    const agentId = 'test-agent-1';
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ];

    await store.saveMessages(agentId, messages);
    const loaded = await store.loadMessages(agentId);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].content[0].text).toBe('Hello');
  });

  it('should check existence', async () => {
    const agentId = 'test-agent-2';
    await store.saveInfo(agentId, { agentId, templateId: 'test', ... });

    expect(await store.exists(agentId)).toBe(true);
    expect(await store.exists('non-existent')).toBe(false);
  });

  // ... more tests for all Store methods
});
```

### Best Practices

1. **Implement all methods** - Store interface has no optional methods
2. **Use transactions** - For operations that modify multiple tables
3. **Index agentId** - All queries filter by agentId
4. **Handle concurrent writes** - Use optimistic locking or upserts
5. **Implement cleanup** - `delete()` must remove all agent data
6. **Test edge cases** - Empty results, missing agents, large payloads

---

*See also: [Architecture Guide](../advanced/architecture.md) | [Production Guide](../advanced/production.md)*
