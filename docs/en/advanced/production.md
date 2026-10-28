# Production Deployment

This guide covers production configuration, monitoring, and best practices for KODE SDK.

---

## Database Selection

### Development vs Production

| Store | Use Case | Features |
|-------|----------|----------|
| `JSONStore` | Development, single machine | Simple file-based storage |
| `SqliteStore` | Development, medium scale | QueryableStore + ExtendedStore |
| `PostgresStore` | Production, multi-worker | Full ExtendedStore, distributed locks |

### PostgreSQL Configuration

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

    // Connection pool settings
    max: 20,                       // Pool size
    idleTimeoutMillis: 30000,      // Idle connection timeout
    connectionTimeoutMillis: 5000, // Connection timeout
  },
  fileStoreBaseDir: '/data/kode-files',
});
```

---

## Health Checks

ExtendedStore provides built-in health check capabilities.

### Health Check API

```typescript
const health = await store.healthCheck();

// Response:
// {
//   healthy: true,
//   database: { connected: true, latencyMs: 5 },
//   fileSystem: { writable: true },
//   checkedAt: 1706000000000
// }
```

### HTTP Health Endpoint

```typescript
import express from 'express';

const app = express();

app.get('/health', async (req, res) => {
  const status = await store.healthCheck();
  res.status(status.healthy ? 200 : 503).json(status);
});

// Kubernetes readiness probe
app.get('/ready', async (req, res) => {
  const status = await store.healthCheck();
  res.status(status.healthy ? 200 : 503).send();
});
```

### Data Consistency Check

```typescript
const consistency = await store.checkConsistency(agentId);

if (!consistency.consistent) {
  console.error('Consistency issues:', consistency.issues);
}
```

---

## Metrics & Monitoring

### Store Metrics

```typescript
const metrics = await store.getMetrics();

// {
//   operations: { saves: 1234, loads: 5678, queries: 910, deletes: 11 },
//   performance: { avgLatencyMs: 15.5, maxLatencyMs: 250, minLatencyMs: 2 },
//   storage: { totalAgents: 100, totalMessages: 50000, dbSizeBytes: 104857600 },
//   collectedAt: 1706000000000
// }
```

### Prometheus Integration

```typescript
import { register, Gauge, Histogram } from 'prom-client';

const agentCount = new Gauge({ name: 'kode_agents_total', help: 'Total agents' });
const toolLatency = new Histogram({
  name: 'kode_tool_duration_seconds',
  help: 'Tool execution duration',
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

## Retry Strategy

### Built-in Retry Configuration

```typescript
import { withRetry, DEFAULT_RETRY_CONFIG } from '@shareai-lab/kode-sdk/provider';

// Default: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 60000, jitterFactor: 0.2 }

const result = await withRetry(
  () => callExternalAPI(),
  { maxRetries: 5, baseDelayMs: 500, provider: 'myservice' },
  (error, attempt, delay) => console.log(`Retry ${attempt} after ${delay}ms`)
);
```

### Retryable Errors

| Error Type | Retryable | Description |
|------------|-----------|-------------|
| `RateLimitError` | Yes | Respects `retry-after` header |
| `TimeoutError` | Yes | Request timeout |
| `ServiceUnavailableError` | Yes | 5xx server errors |
| `AuthenticationError` | No | Invalid credentials |
| `QuotaExceededError` | No | Billing limit reached |

---

## Distributed Locking

### Using Agent Locks

```typescript
const release = await store.acquireAgentLock(agentId, 30000);

try {
  const agent = await Agent.resumeFromStore(agentId, deps);
  await agent.send('Process this task');
} finally {
  await release();
}
```

- **SQLite**: In-memory lock (single process only)
- **PostgreSQL**: Database-level advisory lock (multi-worker safe)

---

## Graceful Shutdown

```typescript
async function gracefulShutdown() {
  // 1. Stop accepting new requests
  server.close();

  // 2. Interrupt running agents
  for (const agentId of pool.list()) {
    const agent = pool.get(agentId);
    if (agent) await agent.interrupt();
  }

  // 3. Close database connections
  await store.close();

  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
```

---

## Logging & Cost Management

### Logger Interface

```typescript
const config: DebugConfig = {
  verbose: false,
  logTokenUsage: true,
  logCache: true,
  logRetries: true,
  redactSensitive: true,
};
```

### Cost Limiting

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

## Security Best Practices

```typescript
// File API boundary; shell execution retains host-user permissions
const sandbox = new LocalSandbox({
  workDir: '/app/workspace',
  enforceBoundary: true,
  allowPaths: ['/app/workspace', '/tmp'],
});

// Permission configuration
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

The allow-list must include tools that require approval: tools absent from it are denied before approval is requested. This configuration allows reads and asks before writing or running a shell command. Register the matching template/tools and an approval handler before sending a request. LocalSandbox is not OS isolation; use a separately isolated backend for untrusted code.

---

## Deployment Checklist

- [ ] Use PostgreSQL for production
- [ ] Configure connection pooling
- [ ] Set up health check endpoints
- [ ] Configure metrics collection
- [ ] Implement graceful shutdown
- [ ] Use environment variables for secrets
- [ ] Enable SSL for database connections
- [ ] Set sandbox boundaries

---

## Deployment Patterns

### Decision Tree

```
+------------------+
|  Decision Tree   |
+------------------+
         |
         v
+----------------------+
| Single user/         |----YES---> Pattern 1: Single Process
| local machine?       |
+--------+-------------+
         | NO
         v
+----------------------+
| < 100 concurrent     |----YES---> Pattern 2: Single Server
| users?               |
+--------+-------------+
         | NO
         v
+----------------------+
| Can run long-running |----YES---> Pattern 3: Worker Microservice
| processes?           |
+--------+-------------+
         | NO
         v
+----------------------+
| Serverless only?     |----YES---> Pattern 4: Hybrid (API + Workers)
+--------+-------------+
```

### Pattern 1: Single Process (CLI/Desktop)

**Best for:** CLI tools, Electron apps, VSCode extensions

```
┌─────────────────────────────┐
│         Your App            │
│  ┌───────────────────────┐  │
│  │      KODE SDK         │  │
│  │  ┌─────────────────┐  │  │
│  │  │   AgentPool     │  │  │
│  │  │   + JSONStore   │  │  │
│  │  └────────┬────────┘  │  │
│  └───────────┼───────────┘  │
└──────────────┼──────────────┘
               │
        ┌──────▼──────┐
        │ Local Files │
        └─────────────┘
```

```typescript
import { Agent, AgentPool, JSONStore } from '@shareai-lab/kode-sdk';
import * as path from 'path';
import * as os from 'os';

const store = new JSONStore(path.join(os.homedir(), '.my-agent'));
const pool = new AgentPool({ dependencies: { store, templateRegistry, sandboxFactory, toolRegistry } });

// Resume or create
const agent = pool.get('main') ?? await pool.create('main', { templateId: 'cli-assistant' });

// Interactive loop
for await (const line of readline) {
  await agent.send(line);
  for await (const env of agent.subscribe(['progress'])) {
    if (env.event.type === 'text_chunk') process.stdout.write(env.event.delta);
    if (env.event.type === 'done') break;
  }
}
```

### Pattern 2: Single Server

**Best for:** Internal tools, small teams, prototypes (<100 concurrent users)

```
┌──────────────────────────────────────────┐
│               Node.js Server             │
│  ┌────────────────────────────────────┐  │
│  │          Express/Hono              │  │
│  │  /api/agents/:id/message (POST)    │  │
│  │  /api/agents/:id/events  (SSE)     │  │
│  └──────────────────┬─────────────────┘  │
│                     │                    │
│  ┌──────────────────▼─────────────────┐  │
│  │          AgentPool (50)            │  │
│  │   SqliteStore / PostgresStore      │  │
│  └──────────────────┬─────────────────┘  │
└─────────────────────┼────────────────────┘
                      │
               ┌──────▼──────┐
               │  Database   │
               └─────────────┘
```

```typescript
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
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

  const result = await agent.complete(message);
  return c.json(result);
});

app.get('/api/agents/:id/events', async (c) => {
  const { id } = c.req.param();
  const agent = pool.get(id);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  return streamSSE(c, async (stream) => {
    for await (const env of agent.subscribe(['progress'])) {
      await stream.writeSSE({ data: JSON.stringify(env.event) });
      if (env.event.type === 'done') break;
    }
  });
});
```

### Pattern 3: Worker Microservice

**Best for:** Production SaaS, 1000+ concurrent users

```
┌─────────────────────────────────────────────────────────────────┐
│                        Load Balancer                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
│   API Server 1  │ │   API Server 2  │ │   API Server N  │
│   (Stateless)   │ │   (Stateless)   │ │   (Stateless)   │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                    ┌────────▼────────┐
                    │   Job Queue     │
                    │   (BullMQ)      │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
┌────────▼────────┐ ┌────────▼────────┐ ┌────────▼────────┐
│   Worker 1      │ │   Worker 2      │ │   Worker N      │
│  AgentPool(50)  │ │  AgentPool(50)  │ │  AgentPool(50)  │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
       ┌──────▼──────┐ ┌─────▼─────┐ ┌─────▼─────┐
       │  PostgreSQL │ │   Redis   │ │    S3     │
       │   (Store)   │ │  (Cache)  │ │  (Files)  │
       └─────────────┘ └───────────┘ └───────────┘
```

**API Server (Stateless):**

```typescript
// api/routes/agent.ts
import { Queue } from 'bullmq';

const queue = new Queue('agent-tasks', { connection: redis });

app.post('/api/agents/:id/message', async (c) => {
  const { id } = c.req.param();
  const { message } = await c.req.json();

  const job = await queue.add('process-message', {
    agentId: id,
    message,
    userId: c.get('userId'),
  });

  return c.json({ jobId: job.id, status: 'queued' });
});

app.get('/api/agents/:id/events', async (c) => {
  const { id } = c.req.param();

  return streamSSE(c, async (stream) => {
    const sub = redis.duplicate();
    await sub.subscribe(`agent:${id}:events`);

    sub.on('message', (channel, message) => {
      stream.writeSSE({ data: message });
    });
  });
});
```

**Worker Process:**

```typescript
// worker/index.ts
import { Worker } from 'bullmq';
import { AgentPool, PostgresStore } from '@shareai-lab/kode-sdk';

const store = new PostgresStore(pgConfig, './data');
const pool = new AgentPool({ dependencies: { store, ... }, maxAgents: 50 });

const worker = new Worker('agent-tasks', async (job) => {
  const { agentId, message } = job.data;

  // Acquire distributed lock
  const release = await store.acquireAgentLock(agentId);

  try {
    let agent = pool.get(agentId);
    if (!agent) {
      const exists = await store.exists(agentId);
      agent = exists
        ? await pool.resume(agentId, getConfig(job.data))
        : await pool.create(agentId, getConfig(job.data));
    }

    await agent.send(message);

    // Stream events to Redis Pub/Sub
    for await (const env of agent.subscribe(['progress'])) {
      await redis.publish(`agent:${agentId}:events`, JSON.stringify(env.event));
      if (env.event.type === 'done') break;
    }
  } finally {
    await release();
  }
}, { connection: redis });

// Periodic cleanup: hibernate idle agents
setInterval(async () => {
  for (const agentId of pool.list()) {
    const agent = pool.get(agentId);
    if (agent && agent.idleTime > 60_000) {
      await agent.persistInfo();
      pool.delete(agentId);
    }
  }
}, 30_000);
```

### Pattern 4: Hybrid Serverless

**Best for:** Serverless frontend + stateful backend

```
┌──────────────────────────────────────────────────────────────┐
│                    Vercel / Cloudflare                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  /api/chat       --> Validate, enqueue, return task ID │  │
│  │  /api/status     --> Check task status from DB         │  │
│  │  /api/stream     --> SSE from Redis Pub/Sub            │  │
│  └──────────────────────────┬─────────────────────────────┘  │
└─────────────────────────────┼────────────────────────────────┘
                              │
                     ┌────────▼────────┐
                     │  Message Queue  │
                     │  (Upstash Redis)│
                     └────────┬────────┘
                              │
┌─────────────────────────────▼────────────────────────────────┐
│                    Railway / Render / Fly.io                 │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Worker Pool (KODE SDK)                    │  │
│  │              Long-running processes                    │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**Serverless API (Vercel):**

```typescript
// app/api/agent/[id]/route.ts
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { message } = await req.json();
  const agentId = params.id;

  // Enqueue for worker processing
  await inngest.send('agent/process', { agentId, message });

  return Response.json({ status: 'processing', agentId });
}
```

**Inngest Worker Function:**

```typescript
// inngest/functions/agent-process.ts
import { inngest } from '@/lib/inngest';
import { Agent, PostgresStore } from '@shareai-lab/kode-sdk';

export const agentProcess = inngest.createFunction(
  { id: 'agent-process' },
  { event: 'agent/process' },
  async ({ event, step }) => {
    const { agentId, message } = event.data;

    const result = await step.run('process', async () => {
      const store = new PostgresStore(pgConfig, '/tmp/data');
      const deps = { store, templateRegistry, toolRegistry, sandboxFactory };
      const exists = await store.exists(agentId);
      const agent = exists
        ? await Agent.resume(agentId, config, deps)
        : await Agent.create({ ...config, agentId }, deps);

      return agent.complete(message);
    });

    await step.run('notify', async () => {
      await notifyUser(agentId, result);
    });

    return result;
  }
);
```

---

## Scaling Strategies

### Strategy 1: Vertical Scaling

**Applicable:** Up to ~100 concurrent agents per process

```typescript
const pool = new AgentPool({
  maxAgents: 100,  // Increase from default 50
  store: new SqliteStore('./agents.db', './data'),
});
```

Optimizations:
- Increase `maxAgents` in AgentPool
- Use SqliteStore/PostgresStore (faster than JSONStore)
- Add memory (agents are memory-bound)
- Use SSD for persistence

### Strategy 2: Agent Sharding

**Applicable:** 100-1000 concurrent agents

```
                    agentId: "user-123-agent-456"
                              |
                              v
                    hash(agentId) % N = worker_index
                              |
              +---------------+---------------+
              |               |               |
         Worker 0        Worker 1        Worker 2
        (agents 0-33)   (agents 34-66)  (agents 67-99)
```

Use consistent hashing to route agents to specific workers.

### Strategy 3: LRU Scheduling

**Applicable:** 1000+ total agents, limited active at once

```typescript
class AgentScheduler {
  private active: LRUCache<string, Agent>;
  private store: Store;

  async get(agentId: string): Promise<Agent> {
    if (this.active.has(agentId)) {
      return this.active.get(agentId)!;
    }

    // Resume from storage
    const agent = await Agent.resume(agentId, config, deps);
    this.active.set(agentId, agent);  // LRU eviction handles hibernation

    return agent;
  }
}
```

---

## Capacity Planning

| Deployment | Agents/Process | Memory/Agent | Concurrent Users |
|------------|----------------|--------------|------------------|
| CLI | 1 | 10-100 MB | 1 |
| Desktop | 5-10 | 50-200 MB | 1 |
| Single Server | 50 | 2-10 MB | 50-100 |
| Worker Cluster (10 nodes) | 500 | 2-10 MB | 500-1000 |
| Worker Cluster (50 nodes) | 2500 | 2-10 MB | 2500-5000 |

**Memory Estimation per Agent:**
- Base object: ~50 KB
- Message history (100 messages): ~500 KB - 5 MB
- Tool records: ~50-500 KB
- Event timeline: ~100 KB - 1 MB
- **Typical total: 1-10 MB**

---

## References

- [Architecture Guide](./architecture.md)
- [Database Guide](../guides/database.md)
- [Error Handling](../guides/error-handling.md)
- [Events Guide](../guides/events.md)
