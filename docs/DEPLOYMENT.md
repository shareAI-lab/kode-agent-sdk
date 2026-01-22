# Deployment Scenarios & Architecture Patterns

This document covers deployment patterns for KODE SDK across different use cases, from CLI tools to production backends.

---

## Scenario Overview

| Scenario | Complexity | Store | Scalability | Example |
|----------|-----------|-------|-------------|---------|
| CLI Tool | Low | JSONStore | Single user | Claude Code |
| Desktop App | Low | JSONStore | Single user | ChatGPT Desktop |
| IDE Plugin | Low | JSONStore | Single user | Cursor |
| Self-hosted Server | Medium | JSONStore/Custom | ~100 concurrent | Internal tool |
| Production Backend | High | PostgreSQL/Redis | 1000+ concurrent | SaaS product |
| Serverless | High | External DB | Auto-scaling | API service |

---

## Scenario 1: CLI Tool

**Characteristics:**
- Single user, single process
- Local file system available
- Long-running process
- No external dependencies needed

**Architecture:**
```
┌─────────────────────────────┐
│         Terminal            │
│  ┌───────────────────────┐  │
│  │      CLI App          │  │
│  │  ┌─────────────────┐  │  │
│  │  │   KODE SDK      │  │  │
│  │  │  ┌───────────┐  │  │  │
│  │  │  │ JSONStore │  │  │  │
│  │  │  └─────┬─────┘  │  │  │
│  │  └────────┼────────┘  │  │
│  └───────────┼───────────┘  │
└──────────────┼──────────────┘
               │
        ┌──────▼──────┐
        │ Local Files │
        │ ~/.my-agent │
        └─────────────┘
```

**Implementation:**
```typescript
import { Agent, AgentPool, JSONStore } from '@shareai-lab/kode-sdk';

const store = new JSONStore(path.join(os.homedir(), '.my-agent'));
const pool = new AgentPool({
  dependencies: { store, templateRegistry, sandboxFactory, toolRegistry }
});

// Resume or create
const agent = await pool.get('main')
  ?? await pool.create('main', { templateId: 'cli-assistant' });

// Interactive loop
const rl = readline.createInterface({ input: stdin, output: stdout });
for await (const line of rl) {
  await agent.send(line);
  for await (const event of agent.subscribeProgress()) {
    if (event.type === 'text_chunk') process.stdout.write(event.delta);
  }
}
```

**Best for:** Developer tools, automation scripts, personal assistants.

---

## Scenario 2: Desktop App (Electron)

**Characteristics:**
- Single user
- Full file system access
- Can run background processes
- May need multiple agents

**Architecture:**
```
┌────────────────────────────────────────────┐
│              Electron App                  │
│  ┌──────────────────────────────────────┐  │
│  │           Renderer Process           │  │
│  │  ┌──────────────────────────────┐    │  │
│  │  │            React UI          │    │  │
│  │  └──────────────┬───────────────┘    │  │
│  └─────────────────┼────────────────────┘  │
│                    │ IPC                    │
│  ┌─────────────────▼────────────────────┐  │
│  │            Main Process              │  │
│  │  ┌──────────────────────────────┐    │  │
│  │  │         AgentPool            │    │  │
│  │  │  ┌────────┐ ┌────────┐      │    │  │
│  │  │  │Agent 1 │ │Agent 2 │ ...  │    │  │
│  │  │  └────────┘ └────────┘      │    │  │
│  │  └──────────────────────────────┘    │  │
│  │  ┌──────────────────────────────┐    │  │
│  │  │         JSONStore            │    │  │
│  │  └──────────────┬───────────────┘    │  │
│  └─────────────────┼────────────────────┘  │
└────────────────────┼────────────────────────┘
                     │
              ┌──────▼──────┐
              │  userData   │
              │   folder    │
              └─────────────┘
```

**Implementation:**
```typescript
// main.ts (Main Process)
import { AgentPool, JSONStore } from '@shareai-lab/kode-sdk';
import { app, ipcMain } from 'electron';

const store = new JSONStore(path.join(app.getPath('userData'), 'agents'));
const pool = new AgentPool({ dependencies: { store, ... } });

ipcMain.handle('agent:send', async (event, { agentId, message }) => {
  const agent = pool.get(agentId) ?? await pool.create(agentId, config);
  await agent.send(message);
  return agent.complete();
});

ipcMain.on('agent:subscribe', (event, { agentId }) => {
  const agent = pool.get(agentId);
  if (!agent) return;

  (async () => {
    for await (const ev of agent.subscribeProgress()) {
      event.sender.send(`agent:event:${agentId}`, ev);
    }
  })();
});
```

**Best for:** Chat applications, productivity tools, AI assistants.

---

## Scenario 3: Self-hosted Server (Single Node)

**Characteristics:**
- Multiple users
- Persistent server process
- Can use local storage
- Moderate concurrency (<100 users)

**Architecture:**
```
┌──────────────────────────────────────────────────┐
│                   Node.js Server                 │
│  ┌────────────────────────────────────────────┐  │
│  │              Express/Hono                  │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │  /api/agents/:id/message  (POST)     │  │  │
│  │  │  /api/agents/:id/events   (SSE)      │  │  │
│  │  └──────────────────────────────────────┘  │  │
│  └────────────────────┬───────────────────────┘  │
│                       │                          │
│  ┌────────────────────▼───────────────────────┐  │
│  │               AgentPool (50)               │  │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐      │  │
│  │  │ A1 │ │ A2 │ │ A3 │ │... │ │A50 │      │  │
│  │  └────┘ └────┘ └────┘ └────┘ └────┘      │  │
│  └────────────────────┬───────────────────────┘  │
│                       │                          │
│  ┌────────────────────▼───────────────────────┐  │
│  │              JSONStore                     │  │
│  └────────────────────┬───────────────────────┘  │
└───────────────────────┼──────────────────────────┘
                        │
                 ┌──────▼──────┐
                 │  /data/     │
                 │   agents    │
                 └─────────────┘
```

**Implementation:**
```typescript
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AgentPool, JSONStore } from '@shareai-lab/kode-sdk';

const app = new Hono();
const store = new JSONStore('/data/agents');
const pool = new AgentPool({ dependencies: { store, ... }, maxAgents: 50 });

// Send message
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

  await agent.send(message);
  const result = await agent.complete();
  return c.json(result);
});

// SSE events
app.get('/api/agents/:id/events', async (c) => {
  const { id } = c.req.param();
  const agent = pool.get(id);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  return streamSSE(c, async (stream) => {
    for await (const event of agent.subscribeProgress()) {
      await stream.writeSSE({ data: JSON.stringify(event) });
    }
  });
});

export default app;
```

**Scaling Limit:** ~50-100 concurrent agents per process. Beyond this, consider worker architecture.

---

## Scenario 4: Production Backend (Multi-node)

**Characteristics:**
- High concurrency (1000+ users)
- Multiple server instances
- Database-backed persistence
- Queue-based processing

**Architecture:**
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

**API Server Implementation:**
```typescript
// api/routes/agent.ts
import { Queue } from 'bullmq';

const queue = new Queue('agent-tasks', { connection: redis });

app.post('/api/agents/:id/message', async (c) => {
  const { id } = c.req.param();
  const { message } = await c.req.json();

  // Add job to queue
  const job = await queue.add('process-message', {
    agentId: id,
    message,
    userId: c.get('userId'),
  });

  return c.json({ jobId: job.id, status: 'queued' });
});

app.get('/api/agents/:id/events', async (c) => {
  const { id } = c.req.param();

  // Subscribe to Redis pub/sub
  return streamSSE(c, async (stream) => {
    const sub = redis.duplicate();
    await sub.subscribe(`agent:${id}:events`);

    sub.on('message', (channel, message) => {
      stream.writeSSE({ data: message });
    });
  });
});
```

**Worker Implementation:**
```typescript
// worker/index.ts
import { Worker } from 'bullmq';
import { AgentPool } from '@shareai-lab/kode-sdk';
import { PostgresStore } from './postgres-store';

const store = new PostgresStore(pgPool);
const pool = new AgentPool({ dependencies: { store, ... }, maxAgents: 50 });

const worker = new Worker('agent-tasks', async (job) => {
  const { agentId, message } = job.data;

  // Get or resume agent
  let agent = pool.get(agentId);
  if (!agent) {
    const exists = await store.exists(agentId);
    agent = exists
      ? await pool.resume(agentId, getConfig(job.data))
      : await pool.create(agentId, getConfig(job.data));
  }

  // Process
  await agent.send(message);

  // Stream events to Redis
  for await (const event of agent.subscribeProgress()) {
    await redis.publish(`agent:${agentId}:events`, JSON.stringify(event));

    if (event.type === 'done') break;
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

**PostgreSQL Store Implementation:**
```sql
-- Schema
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_messages (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  messages JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_tool_records (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  records JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE agent_events (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  channel TEXT NOT NULL,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_events_agent_channel ON agent_events(agent_id, channel, id);
```

---

## Scenario 5: Serverless (Vercel/Lambda)

**Characteristics:**
- Request-scoped execution
- Cold starts
- Execution time limits (10s-300s)
- No local persistence

**Challenges:**
1. **No File System**: JSONStore won't work
2. **Timeout**: Long agent tasks may exceed limits
3. **Cold Start**: Must load state quickly
4. **Stateless**: No in-memory agent pool

**Architecture:**
```
┌──────────────────────────────────────────────────────────────┐
│                     Vercel/Lambda                            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                   API Function                         │  │
│  │                                                        │  │
│  │  Request → Load Agent → Execute Step → Persist → Response  │
│  │                                                        │  │
│  └──────────────────────────┬─────────────────────────────┘  │
└─────────────────────────────┼────────────────────────────────┘
                              │
               ┌──────────────┼──────────────┐
               │              │              │
        ┌──────▼──────┐ ┌─────▼─────┐ ┌─────▼─────┐
        │  Supabase   │ │  Upstash  │ │  Inngest  │
        │ (Postgres)  │ │  (Redis)  │ │  (Queue)  │
        └─────────────┘ └───────────┘ └───────────┘
```

**Implementation:**
```typescript
// app/api/agent/[id]/route.ts
import { Agent, AgentConfig } from '@shareai-lab/kode-sdk';
import { SupabaseStore } from '@/lib/supabase-store';

const store = new SupabaseStore(supabaseClient);

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const { message } = await req.json();
  const agentId = params.id;

  // 1. Load or create agent
  const exists = await store.exists(agentId);
  const agent = exists
    ? await Agent.resume(agentId, config, { store, ... })
    : await Agent.create({ ...config, agentId }, { store, ... });

  // 2. Send message
  await agent.send(message);

  // 3. Run with timeout (leave buffer for response)
  const timeoutMs = 25_000; // Vercel Pro = 30s
  let result;

  try {
    result = await Promise.race([
      agent.complete(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      ),
    ]);
  } catch (e) {
    if (e.message === 'Timeout') {
      // Agent still processing, queue for background
      await inngest.send('agent/continue', { agentId });
      return Response.json({ status: 'processing', agentId });
    }
    throw e;
  }

  return Response.json({ status: 'done', output: result.text });
}
```

**For Long-running Tasks:**
Use a queue service like Inngest:

```typescript
// inngest/functions/agent-continue.ts
import { inngest } from '@/lib/inngest';

export const agentContinue = inngest.createFunction(
  { id: 'agent-continue' },
  { event: 'agent/continue' },
  async ({ event, step }) => {
    const { agentId } = event.data;

    // Resume agent
    const agent = await Agent.resume(agentId, config, { store, ... });

    // Process until done (Inngest handles timeouts)
    const result = await step.run('complete', async () => {
      return agent.complete();
    });

    // Notify user via webhook/push
    await step.run('notify', async () => {
      await notifyUser(agentId, result);
    });

    return result;
  }
);
```

---

## Custom Store Implementations

### PostgreSQL Store (Full Example)

```typescript
import { Store, Message, ToolCallRecord, Timeline, Bookmark, ... } from '@shareai-lab/kode-sdk';
import { Pool } from 'pg';

export class PostgresStore implements Store {
  constructor(private pool: Pool) {}

  // === Runtime State ===

  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    await this.pool.query(`
      INSERT INTO agent_messages (agent_id, messages, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET messages = $2, updated_at = NOW()
    `, [agentId, JSON.stringify(messages)]);
  }

  async loadMessages(agentId: string): Promise<Message[]> {
    const { rows } = await this.pool.query(
      'SELECT messages FROM agent_messages WHERE agent_id = $1',
      [agentId]
    );
    return rows[0]?.messages || [];
  }

  async saveToolCallRecords(agentId: string, records: ToolCallRecord[]): Promise<void> {
    await this.pool.query(`
      INSERT INTO agent_tool_records (agent_id, records, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET records = $2, updated_at = NOW()
    `, [agentId, JSON.stringify(records)]);
  }

  async loadToolCallRecords(agentId: string): Promise<ToolCallRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT records FROM agent_tool_records WHERE agent_id = $1',
      [agentId]
    );
    return rows[0]?.records || [];
  }

  // === Events ===

  async appendEvent(agentId: string, timeline: Timeline): Promise<void> {
    await this.pool.query(`
      INSERT INTO agent_events (agent_id, channel, event, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [agentId, timeline.event.channel, JSON.stringify(timeline)]);
  }

  async *readEvents(agentId: string, opts?: { since?: Bookmark; channel?: string }): AsyncIterable<Timeline> {
    const conditions = ['agent_id = $1'];
    const params: any[] = [agentId];
    let paramIndex = 2;

    if (opts?.since) {
      conditions.push(`id > $${paramIndex++}`);
      params.push(opts.since.seq);
    }
    if (opts?.channel) {
      conditions.push(`channel = $${paramIndex++}`);
      params.push(opts.channel);
    }

    const { rows } = await this.pool.query(`
      SELECT event FROM agent_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY id ASC
    `, params);

    for (const row of rows) {
      yield row.event;
    }
  }

  // ... implement remaining methods (history, snapshots, metadata, lifecycle)

  async exists(agentId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM agents WHERE id = $1',
      [agentId]
    );
    return rows.length > 0;
  }

  async delete(agentId: string): Promise<void> {
    await this.pool.query('DELETE FROM agents WHERE id = $1', [agentId]);
  }

  async list(prefix?: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      prefix
        ? 'SELECT id FROM agents WHERE id LIKE $1'
        : 'SELECT id FROM agents',
      prefix ? [`${prefix}%`] : []
    );
    return rows.map(r => r.id);
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

## Summary

1. **CLI/Desktop/IDE**: Use JSONStore, single AgentPool, straightforward
2. **Single Server**: Add HTTP layer, consider Redis for events
3. **Multi-node**: Implement custom Store, use queue for job distribution
4. **Serverless**: Use external DB, handle timeouts, consider background queue

The key insight: **KODE SDK handles the agent lifecycle; you handle the infrastructure.**
