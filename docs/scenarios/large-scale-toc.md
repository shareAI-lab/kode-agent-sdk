# Scenario: Large-Scale ToC Applications

> Build ChatGPT/Manus-like applications serving thousands of concurrent users with hundreds of agents each.

---

## The Challenge

Building a consumer-facing AI application at scale requires solving:

| Challenge | Description |
|-----------|-------------|
| **High Concurrency** | 10K+ users, each with multiple agents |
| **Agent Hibernation** | Inactive agents must sleep to save resources |
| **Crash Recovery** | Server restart must restore all running agents |
| **Fork Exploration** | Users fork agents to explore different paths |
| **Multi-Machine** | Scale horizontally across servers |
| **Serverless Frontend** | Deploy UI on Vercel/Cloudflare |

**Direct KODE SDK Usage: Not Suitable**

KODE SDK is designed as a runtime kernel, not a distributed platform. For large-scale ToC, you need the **Worker Microservice Pattern**.

---

## Recommended Architecture

```
+------------------------------------------------------------------+
|                        User Devices                               |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                    CDN / Edge (Cloudflare)                       |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                 API Gateway (Vercel/Cloudflare)                  |
|                                                                   |
|   /api/agents        - List user's agents                        |
|   /api/agents/:id    - Get agent status                          |
|   /api/chat          - Send message (enqueue)                    |
|   /api/fork          - Fork agent (enqueue)                      |
|   /api/stream/:id    - SSE stream (from Redis)                   |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                    Message Queue (Upstash Redis)                 |
|                                                                   |
|   Queue: agent:messages      - Chat messages                     |
|   Queue: agent:commands      - Fork, hibernate, resume           |
|   PubSub: agent:events:{id}  - Real-time events                  |
+------------------------------------------------------------------+
                               |
              +----------------+----------------+
              |                |                |
              v                v                v
+------------------+  +------------------+  +------------------+
|   Worker Pool 1  |  |   Worker Pool 2  |  |   Worker Pool N  |
|   (Railway)      |  |   (Railway)      |  |   (Railway)      |
|                  |  |                  |  |                  |
|   +----------+   |  |   +----------+   |  |   +----------+   |
|   | KODE SDK |   |  |   | KODE SDK |   |  |   | KODE SDK |   |
|   | Scheduler|   |  |   | Scheduler|   |  |   | Scheduler|   |
|   +----------+   |  |   +----------+   |  |   +----------+   |
|                  |  |                  |  |                  |
|   Agents: 0-999  |  |  Agents: 1K-2K   |  |  Agents: 2K-3K   |
+--------+---------+  +--------+---------+  +--------+---------+
         |                     |                     |
         +---------------------+---------------------+
                               |
                               v
+------------------------------------------------------------------+
|                    Distributed Store                              |
|                                                                   |
|   PostgreSQL (Supabase)     - Agent state, messages, metadata    |
|   Redis Cluster             - Locks, sessions, hot cache         |
|   S3/R2                     - File attachments, archives         |
+------------------------------------------------------------------+
```

---

## Component Implementation

### 1. API Layer (Serverless)

```typescript
// app/api/chat/route.ts (Next.js App Router)
import { NextRequest } from 'next/server';
import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';

const redis = new Redis({ url: process.env.UPSTASH_URL!, token: process.env.UPSTASH_TOKEN! });
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

export async function POST(req: NextRequest) {
  // 1. Authenticate user
  const user = await authenticateUser(req);
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Parse request
  const { agentId, message } = await req.json();

  // 3. Verify agent ownership
  const { data: agent } = await supabase
    .from('agents')
    .select('id, user_id, state')
    .eq('id', agentId)
    .single();

  if (!agent || agent.user_id !== user.id) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }

  // 4. Create task and enqueue
  const taskId = crypto.randomUUID();

  await redis.lpush('agent:messages', JSON.stringify({
    taskId,
    agentId,
    userId: user.id,
    message,
    timestamp: Date.now(),
  }));

  // 5. Update agent state
  await supabase
    .from('agents')
    .update({ state: 'QUEUED', last_activity: new Date() })
    .eq('id', agentId);

  // 6. Return task ID for polling/streaming
  return Response.json({
    taskId,
    streamUrl: `/api/stream/${taskId}`,
  });
}
```

### 2. SSE Stream Endpoint

```typescript
// app/api/stream/[taskId]/route.ts
import { Redis } from '@upstash/redis';

const redis = new Redis({ url: process.env.UPSTASH_URL!, token: process.env.UPSTASH_TOKEN! });

export async function GET(
  req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const { taskId } = params;

  // Create SSE stream
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // Subscribe to Redis PubSub
      const subscriber = redis.duplicate();
      await subscriber.subscribe(`task:${taskId}:events`, (message) => {
        const event = JSON.parse(message);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

        if (event.kind === 'done' || event.kind === 'error') {
          controller.close();
          subscriber.unsubscribe();
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        controller.close();
        subscriber.unsubscribe();
      }, 5 * 60 * 1000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

### 3. Worker Service

```typescript
// worker/index.ts
import { Agent, AgentPool } from '@anthropic/kode-sdk';
import { Redis } from 'ioredis';
import { PostgresStore } from './postgres-store';
import { AgentScheduler } from './scheduler';

const redis = new Redis(process.env.REDIS_URL!);
const store = new PostgresStore(process.env.DATABASE_URL!);

// Scheduler manages agent lifecycle
const scheduler = new AgentScheduler({
  maxActiveAgents: 100,  // Per worker
  idleTimeout: 5 * 60 * 1000,  // 5 minutes
  store,
});

// Process message queue
async function processMessages() {
  while (true) {
    // Blocking pop from queue
    const result = await redis.brpop('agent:messages', 30);

    if (!result) continue;

    const task = JSON.parse(result[1]);

    try {
      // Get or resume agent
      const agent = await scheduler.getOrResume(task.agentId);

      // Subscribe to events and forward to Redis PubSub
      agent.subscribeProgress({ kinds: ['text_chunk', 'tool:start', 'tool:complete', 'done'] }, async (event) => {
        await redis.publish(`task:${task.taskId}:events`, JSON.stringify(event));
      });

      // Process message
      await agent.chat(task.message);

      // Publish completion
      await redis.publish(`task:${task.taskId}:events`, JSON.stringify({
        kind: 'done',
        taskId: task.taskId,
      }));

    } catch (error) {
      // Publish error
      await redis.publish(`task:${task.taskId}:events`, JSON.stringify({
        kind: 'error',
        taskId: task.taskId,
        error: error.message,
      }));
    }
  }
}

// Start worker
processMessages().catch(console.error);
```

### 4. Agent Scheduler

```typescript
// worker/scheduler.ts
import { Agent } from '@anthropic/kode-sdk';
import { LRUCache } from 'lru-cache';

export class AgentScheduler {
  private active: LRUCache<string, Agent>;
  private store: PostgresStore;
  private config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    this.config = config;
    this.store = config.store;

    this.active = new LRUCache({
      max: config.maxActiveAgents,
      dispose: (agent, agentId) => {
        // Auto-hibernate when evicted
        this.hibernate(agentId, agent);
      },
      ttl: config.idleTimeout,
    });
  }

  async getOrResume(agentId: string): Promise<Agent> {
    // Check active cache
    if (this.active.has(agentId)) {
      return this.active.get(agentId)!;
    }

    // Acquire distributed lock
    const lockId = await this.store.acquireLock(agentId, 60000);
    if (!lockId) {
      throw new Error('Agent is being processed by another worker');
    }

    try {
      // Resume from database
      const agent = await Agent.resume(agentId, this.getConfig(agentId), this.getDeps());

      // Cache in active pool
      this.active.set(agentId, agent);

      // Setup idle tracking
      agent.onIdle(() => {
        this.active.delete(agentId);  // Triggers dispose -> hibernate
      });

      return agent;

    } finally {
      await this.store.releaseLock(agentId, lockId);
    }
  }

  private async hibernate(agentId: string, agent: Agent): Promise<void> {
    try {
      await agent.persistInfo();
      await this.store.updateAgentState(agentId, 'HIBERNATED');
      console.log(`Hibernated agent: ${agentId}`);
    } catch (error) {
      console.error(`Failed to hibernate ${agentId}:`, error);
    }
  }
}
```

### 5. PostgreSQL Store

```typescript
// worker/postgres-store.ts
import { Pool } from 'pg';
import { Store, Message, AgentInfo, ToolCallRecord } from '@anthropic/kode-sdk';

export class PostgresStore implements Store {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
    });
  }

  // Distributed lock using PostgreSQL Advisory Locks
  async acquireLock(agentId: string, ttlMs: number): Promise<string | null> {
    const lockKey = this.hashAgentId(agentId);
    const client = await this.pool.connect();

    try {
      const result = await client.query(
        'SELECT pg_try_advisory_lock($1) as acquired',
        [lockKey]
      );

      if (result.rows[0].acquired) {
        const lockId = crypto.randomUUID();

        // Set expiry using a separate table
        await client.query(
          `INSERT INTO agent_locks (agent_id, lock_id, expires_at)
           VALUES ($1, $2, NOW() + interval '${ttlMs} milliseconds')
           ON CONFLICT (agent_id) DO UPDATE SET lock_id = $2, expires_at = NOW() + interval '${ttlMs} milliseconds'`,
          [agentId, lockId]
        );

        return lockId;
      }

      return null;
    } finally {
      client.release();
    }
  }

  async releaseLock(agentId: string, lockId: string): Promise<void> {
    const lockKey = this.hashAgentId(agentId);
    const client = await this.pool.connect();

    try {
      // Verify lock ownership
      const result = await client.query(
        'SELECT lock_id FROM agent_locks WHERE agent_id = $1',
        [agentId]
      );

      if (result.rows[0]?.lock_id === lockId) {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        await client.query('DELETE FROM agent_locks WHERE agent_id = $1', [agentId]);
      }
    } finally {
      client.release();
    }
  }

  // Messages stored as JSONB
  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_messages (agent_id, messages, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (agent_id) DO UPDATE SET messages = $2, updated_at = NOW()`,
      [agentId, JSON.stringify(messages)]
    );
  }

  async loadMessages(agentId: string): Promise<Message[]> {
    const result = await this.pool.query(
      'SELECT messages FROM agent_messages WHERE agent_id = $1',
      [agentId]
    );
    return result.rows[0]?.messages || [];
  }

  // ... implement other Store methods
}
```

---

## Database Schema

```sql
-- Agents table
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  template_id TEXT NOT NULL,
  state TEXT DEFAULT 'READY',
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agents_user ON agents(user_id);
CREATE INDEX idx_agents_state ON agents(state);

-- Messages (one row per agent, JSONB array)
CREATE TABLE agent_messages (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  messages JSONB NOT NULL DEFAULT '[]',
  version INTEGER DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tool call records
CREATE TABLE tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  input JSONB,
  result JSONB,
  state TEXT DEFAULT 'PENDING',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_tool_calls_agent ON tool_calls(agent_id);

-- Checkpoints (for fork)
CREATE TABLE checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_checkpoint_id UUID REFERENCES checkpoints(id),
  snapshot JSONB NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_checkpoints_agent ON checkpoints(agent_id);

-- Distributed locks
CREATE TABLE agent_locks (
  agent_id UUID PRIMARY KEY,
  lock_id UUID NOT NULL,
  worker_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Row Level Security
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access own agents" ON agents
  FOR ALL USING (auth.uid() = user_id);

ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access own agent messages" ON agent_messages
  FOR ALL USING (
    agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  );
```

---

## Handling Special Scenarios

### Agent Hibernation (Inactive Users)

```typescript
// Cron job: Check for idle agents every 5 minutes
async function hibernateIdleAgents() {
  const idleThreshold = new Date(Date.now() - 30 * 60 * 1000);  // 30 minutes

  const { data: idleAgents } = await supabase
    .from('agents')
    .select('id')
    .eq('state', 'ACTIVE')
    .lt('last_activity', idleThreshold.toISOString());

  for (const agent of idleAgents || []) {
    await redis.lpush('agent:commands', JSON.stringify({
      command: 'hibernate',
      agentId: agent.id,
    }));
  }
}
```

### Server Crash Recovery

```typescript
// On worker startup
async function recoverFromCrash() {
  // Find agents that were being processed by this worker
  const { data: orphanedAgents } = await supabase
    .from('agents')
    .select('id')
    .eq('state', 'PROCESSING')
    .eq('worker_id', WORKER_ID);

  for (const agent of orphanedAgents || []) {
    console.log(`Recovering agent: ${agent.id}`);

    // Resume with crash strategy
    const recovered = await Agent.resume(agent.id, config, deps, {
      strategy: 'crash',  // Auto-seal incomplete tool calls
    });

    // Re-queue for processing
    await redis.lpush('agent:messages', JSON.stringify({
      taskId: `recovery-${agent.id}`,
      agentId: agent.id,
      message: null,  // No new message, just recover
      isRecovery: true,
    }));
  }
}

// Call on startup
recoverFromCrash();
```

### Fork Multiple Agents

```typescript
// API endpoint for forking
export async function POST(req: NextRequest) {
  const { agentId, checkpointId, count = 1 } = await req.json();

  // Validate: max 10 forks at once
  if (count > 10) {
    return Response.json({ error: 'Max 10 forks at once' }, { status: 400 });
  }

  const forkIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const forkId = `${agentId}-fork-${Date.now()}-${i}`;

    await redis.lpush('agent:commands', JSON.stringify({
      command: 'fork',
      agentId,
      checkpointId,
      forkId,
    }));

    forkIds.push(forkId);
  }

  return Response.json({ forkIds });
}

// Worker handles fork command
async function handleForkCommand(command: ForkCommand) {
  const parent = await scheduler.getOrResume(command.agentId);

  const forked = await parent.fork(command.checkpointId);

  // Store forked agent
  await supabase.from('agents').insert({
    id: command.forkId,
    user_id: parent.userId,
    parent_agent_id: command.agentId,
    // ... copy other fields
  });
}
```

### Membership Expiry

```typescript
// Webhook from payment provider
export async function POST(req: NextRequest) {
  const event = await req.json();

  if (event.type === 'subscription.cancelled') {
    const userId = event.data.user_id;

    // Pause all user's agents
    await supabase
      .from('agents')
      .update({ state: 'MEMBERSHIP_PAUSED' })
      .eq('user_id', userId);

    // Hibernate any active agents
    const { data: activeAgents } = await supabase
      .from('agents')
      .select('id')
      .eq('user_id', userId)
      .eq('state', 'ACTIVE');

    for (const agent of activeAgents || []) {
      await redis.lpush('agent:commands', JSON.stringify({
        command: 'hibernate',
        agentId: agent.id,
        reason: 'membership_expired',
      }));
    }
  }

  if (event.type === 'subscription.renewed') {
    const userId = event.data.user_id;

    // Unpause all agents
    await supabase
      .from('agents')
      .update({ state: 'HIBERNATED' })
      .eq('user_id', userId)
      .eq('state', 'MEMBERSHIP_PAUSED');
  }
}
```

---

## Performance Considerations

### Message Storage Optimization

```typescript
// Instead of storing full messages array
// Use append-only log with periodic compaction

class OptimizedMessageStore {
  async appendMessage(agentId: string, message: Message) {
    // Append to log table (fast)
    await this.pool.query(
      `INSERT INTO message_log (agent_id, seq, message)
       VALUES ($1, nextval('message_seq'), $2)`,
      [agentId, JSON.stringify(message)]
    );

    // Increment message count
    await this.pool.query(
      `UPDATE agents SET message_count = message_count + 1 WHERE id = $1`,
      [agentId]
    );
  }

  async loadMessages(agentId: string, limit = 100): Promise<Message[]> {
    // Load latest messages (pagination)
    const result = await this.pool.query(
      `SELECT message FROM message_log
       WHERE agent_id = $1
       ORDER BY seq DESC
       LIMIT $2`,
      [agentId, limit]
    );

    return result.rows.reverse().map(r => r.message);
  }
}
```

### Fork Optimization (Copy-on-Write)

```typescript
// Fork without copying all messages
async function forkAgentCOW(agentId: string, checkpointId: string): Promise<string> {
  const forkId = generateForkId();

  // Copy only metadata, reference same message log
  await this.pool.query(
    `INSERT INTO agents (id, user_id, template_id, config, fork_base_checkpoint_id)
     SELECT $1, user_id, template_id, config, $2
     FROM agents WHERE id = $3`,
    [forkId, checkpointId, agentId]
  );

  // New messages go to fork's own log
  // Old messages read from checkpoint reference

  return forkId;
}
```

---

## Deployment Checklist

- [ ] API layer deployed to Vercel/Cloudflare
- [ ] Workers deployed to Railway/Render/Fly.io
- [ ] PostgreSQL (Supabase) configured with RLS
- [ ] Redis (Upstash) for queues and pub/sub
- [ ] S3/R2 for file attachments
- [ ] Monitoring (Sentry, DataDog, etc.)
- [ ] Rate limiting configured
- [ ] Graceful shutdown handlers
- [ ] Health check endpoints
- [ ] Auto-scaling rules for workers

---

## Cost Estimation

| Component | ~10K Users | ~100K Users |
|-----------|------------|-------------|
| Vercel (API) | $20/mo | $100/mo |
| Railway (Workers) | $50/mo | $500/mo |
| Supabase (PostgreSQL) | $25/mo | $100/mo |
| Upstash (Redis) | $10/mo | $50/mo |
| **Total** | **~$100/mo** | **~$750/mo** |

*Excludes LLM API costs*

---

## Summary

Building a large-scale ToC application with KODE SDK requires:

1. **Separate concerns**: Stateless API + Stateful workers
2. **Queue-based communication**: Decouple request handling from agent execution
3. **Distributed store**: PostgreSQL for persistence, Redis for real-time
4. **Agent scheduling**: LRU cache for active agents, hibernate inactive
5. **Crash recovery**: WAL + checkpoint for resilience

KODE SDK provides the agent runtime kernel. You build the platform around it.
