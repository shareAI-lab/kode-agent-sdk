# Scenario: Web Backend (Self-Hosted)

> Deploy KODE SDK on your own servers for small to medium web applications.

---

## When to Use This Pattern

| Criteria | Threshold |
|----------|-----------|
| Concurrent users | < 1,000 |
| Concurrent agents | < 100 |
| Infrastructure | Single server / small cluster |
| Complexity | Moderate |

**Compatibility: 80%** - Need to add HTTP layer and user isolation.

---

## Architecture

```
+------------------------------------------------------------------+
|                       Your Server                                 |
+------------------------------------------------------------------+
|                                                                   |
|   +------------------+     +------------------+                   |
|   |   HTTP Layer     |     |   KODE SDK       |                   |
|   |   (Express/Hono) |---->|   AgentPool      |                   |
|   +------------------+     +------------------+                   |
|                                   |                               |
|   +------------------+     +------v------+                        |
|   |   Auth Layer     |     |    Store    |                        |
|   |   (Passport/etc) |     | (Redis/PG)  |                        |
|   +------------------+     +-------------+                        |
|                                                                   |
+------------------------------------------------------------------+
```

---

## Express.js Integration

```typescript
// server.ts
import express from 'express';
import { Agent, AgentPool, AnthropicProvider, LocalSandbox } from '@anthropic/kode-sdk';
import { RedisStore } from './redis-store';  // Custom implementation

const app = express();
const store = new RedisStore(process.env.REDIS_URL!);
const pool = new AgentPool({ store, maxAgents: 100 });

app.use(express.json());

// Middleware: Auth
app.use(async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  req.user = await verifyToken(token);
  next();
});

// Create agent for user
app.post('/api/agents', async (req, res) => {
  const { name, systemPrompt } = req.body;
  const agentId = `${req.user.id}-${Date.now()}`;

  const agent = await pool.create(agentId, {
    template: { systemPrompt },
    config: {
      metadata: { userId: req.user.id, name },
    },
  }, {
    modelProvider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY!),
    sandbox: new LocalSandbox({ workDir: `/tmp/agents/${agentId}` }),
  });

  res.json({ agentId, name });
});

// List user's agents
app.get('/api/agents', async (req, res) => {
  const agents = await store.listAgentsByUser(req.user.id);
  res.json(agents);
});

// Chat with agent
app.post('/api/agents/:agentId/chat', async (req, res) => {
  const { agentId } = req.params;
  const { message } = req.body;

  // Verify ownership
  const info = await store.loadInfo(agentId);
  if (info?.metadata?.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Get or resume agent
  let agent = pool.get(agentId);
  if (!agent) {
    agent = await pool.resume(agentId, {
      template: { systemPrompt: info.systemPrompt },
    }, {
      modelProvider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY!),
      sandbox: new LocalSandbox({ workDir: `/tmp/agents/${agentId}` }),
    });
  }

  // Stream response via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  agent.subscribeProgress({ kinds: ['text_chunk', 'tool:start', 'tool:complete', 'done'] }, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);

    if (event.kind === 'done') {
      res.end();
    }
  });

  await agent.chat(message);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  for (const [id, agent] of pool.agents) {
    await agent.persistInfo();
  }
  process.exit(0);
});

app.listen(3000, () => console.log('Server running on :3000'));
```

---

## Hono (Edge-Compatible)

```typescript
// server.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';

const app = new Hono();

app.post('/api/agents/:agentId/chat', async (c) => {
  const agentId = c.req.param('agentId');
  const { message } = await c.req.json();

  const agent = await getOrResumeAgent(agentId);

  return streamSSE(c, async (stream) => {
    agent.subscribeProgress({ kinds: ['text_chunk', 'done'] }, async (event) => {
      await stream.writeSSE({ data: JSON.stringify(event) });

      if (event.kind === 'done') {
        await stream.close();
      }
    });

    await agent.chat(message);
  });
});

serve(app, { port: 3000 });
```

---

## User Isolation

### Per-User Agent Namespace

```typescript
// Prefix all agent IDs with user ID
function getAgentId(userId: string, localId: string): string {
  return `user:${userId}:agent:${localId}`;
}

// List only user's agents
async function listUserAgents(userId: string): Promise<AgentInfo[]> {
  const allAgents = await store.listAgents();
  return allAgents.filter(a => a.metadata?.userId === userId);
}
```

### Per-User Sandbox Isolation

```typescript
// Each user gets isolated workspace
function getUserSandbox(userId: string, agentId: string): LocalSandbox {
  const workDir = path.join('/data/workspaces', userId, agentId);

  return new LocalSandbox({
    workDir,
    allowedPaths: [workDir],  // Restrict to user's directory only
    env: {
      USER_ID: userId,
      AGENT_ID: agentId,
    },
  });
}
```

---

## Redis Store Implementation

```typescript
// redis-store.ts
import Redis from 'ioredis';
import { Store, Message, AgentInfo, ToolCallRecord } from '@anthropic/kode-sdk';

export class RedisStore implements Store {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    await this.redis.set(`agent:${agentId}:messages`, JSON.stringify(messages));
  }

  async loadMessages(agentId: string): Promise<Message[]> {
    const data = await this.redis.get(`agent:${agentId}:messages`);
    return data ? JSON.parse(data) : [];
  }

  async saveInfo(agentId: string, info: AgentInfo): Promise<void> {
    await this.redis.set(`agent:${agentId}:info`, JSON.stringify(info));
    // Add to user's agent list
    if (info.metadata?.userId) {
      await this.redis.sadd(`user:${info.metadata.userId}:agents`, agentId);
    }
  }

  async loadInfo(agentId: string): Promise<AgentInfo | undefined> {
    const data = await this.redis.get(`agent:${agentId}:info`);
    return data ? JSON.parse(data) : undefined;
  }

  async listAgentsByUser(userId: string): Promise<AgentInfo[]> {
    const agentIds = await this.redis.smembers(`user:${userId}:agents`);
    const infos = await Promise.all(agentIds.map(id => this.loadInfo(id)));
    return infos.filter(Boolean) as AgentInfo[];
  }

  async deleteAgent(agentId: string): Promise<void> {
    const info = await this.loadInfo(agentId);
    if (info?.metadata?.userId) {
      await this.redis.srem(`user:${info.metadata.userId}:agents`, agentId);
    }
    await this.redis.del(
      `agent:${agentId}:messages`,
      `agent:${agentId}:info`,
      `agent:${agentId}:tools`,
    );
  }
}
```

---

## Rate Limiting

```typescript
import rateLimit from 'express-rate-limit';

// Global rate limit
app.use(rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 60,  // 60 requests per minute
}));

// Per-user rate limit for chat
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,  // 20 chat requests per minute per user
  keyGenerator: (req) => req.user?.id || req.ip,
});

app.post('/api/agents/:agentId/chat', chatLimiter, async (req, res) => {
  // ...
});

// Token-based rate limiting
const tokenTracker = new Map<string, number>();

agent.subscribeMonitor((event) => {
  if (event.kind === 'token_usage') {
    const userId = agent.metadata?.userId;
    const current = tokenTracker.get(userId) || 0;
    tokenTracker.set(userId, current + event.totalTokens);

    if (current + event.totalTokens > DAILY_TOKEN_LIMIT) {
      agent.stop();
      throw new Error('Daily token limit exceeded');
    }
  }
});
```

---

## Health Checks

```typescript
// Health check endpoint
app.get('/health', async (req, res) => {
  const checks = {
    redis: await checkRedis(),
    agents: pool.agents.size,
    memory: process.memoryUsage(),
  };

  const healthy = checks.redis;
  res.status(healthy ? 200 : 503).json(checks);
});

async function checkRedis(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

// Kubernetes readiness probe
app.get('/ready', (req, res) => {
  res.sendStatus(200);
});

// Kubernetes liveness probe
app.get('/live', (req, res) => {
  res.sendStatus(200);
});
```

---

## Docker Deployment

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY dist ./dist

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

```yaml
# docker-compose.yml
version: '3.8'

services:
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - REDIS_URL=redis://redis:6379
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    depends_on:
      - redis
    deploy:
      replicas: 2
      restart_policy:
        condition: on-failure

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

---

## Scaling to Multiple Instances

When running multiple server instances:

### 1. Use Redis for Session Affinity

```typescript
// Store which server handles which agent
await redis.set(`agent:${agentId}:server`, SERVER_ID, 'EX', 3600);

// Check before resuming
const currentServer = await redis.get(`agent:${agentId}:server`);
if (currentServer && currentServer !== SERVER_ID) {
  // Agent is on another server, redirect or wait
}
```

### 2. Distributed Locking

```typescript
import Redlock from 'redlock';

const redlock = new Redlock([redis]);

app.post('/api/agents/:agentId/chat', async (req, res) => {
  const lock = await redlock.acquire([`lock:agent:${agentId}`], 30000);

  try {
    // Only one server can process this agent at a time
    const agent = await getOrResumeAgent(agentId);
    await agent.chat(message);
  } finally {
    await lock.release();
  }
});
```

---

## Migration Path to Large Scale

When you outgrow single-server deployment:

1. **Add message queue** - Decouple API from processing
2. **Separate workers** - Run agents in dedicated processes
3. **Use PostgreSQL** - Replace Redis for primary storage
4. **Add agent scheduler** - Manage agent lifecycle

See [Large-Scale ToC Guide](./large-scale-toc.md) for the full architecture.
