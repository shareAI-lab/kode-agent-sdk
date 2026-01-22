# KODE SDK Architecture Guide

> Deep dive into the mental model, design decisions, and deployment patterns for KODE SDK.

---

## Table of Contents

1. [Mental Model](#mental-model)
2. [Core Architecture](#core-architecture)
3. [Runtime Characteristics](#runtime-characteristics)
4. [Deployment Patterns](#deployment-patterns)
5. [Scaling Strategies](#scaling-strategies)
6. [Decision Framework](#decision-framework)

---

## Mental Model

### What KODE SDK Is

```
Think of KODE SDK like:

+------------------+     +------------------+     +------------------+
|       V8         |     |     SQLite       |     |    KODE SDK      |
|  JS Runtime      |     |  Database Engine |     |  Agent Runtime   |
+------------------+     +------------------+     +------------------+
        |                        |                        |
        v                        v                        v
+------------------+     +------------------+     +------------------+
|    Express.js    |     |     Prisma       |     |   Your App       |
|  Web Framework   |     |       ORM        |     | (CLI/Desktop/Web)|
+------------------+     +------------------+     +------------------+
        |                        |                        |
        v                        v                        v
+------------------+     +------------------+     +------------------+
|      Vercel      |     |   PlanetScale    |     |   Your Infra     |
|  Cloud Platform  |     |  Cloud Database  |     | (K8s/EC2/Local)  |
+------------------+     +------------------+     +------------------+
```

**KODE SDK is an engine, not a platform.**

It provides:
- Agent lifecycle management (create, run, pause, resume, fork)
- State persistence (via pluggable Store interface)
- Tool execution and permission governance
- Event streams for observability

It does NOT provide:
- HTTP routing or API framework
- User authentication or authorization
- Multi-tenancy or resource isolation
- Horizontal scaling or load balancing

### The Single Responsibility

```
                     KODE SDK's Job
                           |
                           v
    +----------------------------------------------+
    |                                              |
    |   "Keep this agent running, recover from    |
    |    crashes, let it fork, and tell me        |
    |    what's happening via events."            |
    |                                              |
    +----------------------------------------------+
                           |
                           v
                     Your App's Job
                           |
                           v
    +----------------------------------------------+
    |                                              |
    |   "Handle users, route requests, manage     |
    |    permissions, scale infrastructure,       |
    |    and integrate with my systems."          |
    |                                              |
    +----------------------------------------------+
```

---

## Core Architecture

### Component Overview

```
+------------------------------------------------------------------+
|                         Agent Instance                            |
+------------------------------------------------------------------+
|                                                                   |
|  +------------------+  +------------------+  +------------------+ |
|  |  MessageQueue    |  | ContextManager   |  |   ToolRunner     | |
|  |  (User inputs)   |  | (Token mgmt)     |  | (Parallel exec)  | |
|  +--------+---------+  +--------+---------+  +--------+---------+ |
|           |                     |                     |           |
|           +---------------------+---------------------+           |
|                                 |                                 |
|                    +------------v------------+                    |
|                    |      BreakpointManager  |                    |
|                    |   (7-stage state track) |                    |
|                    +------------+------------+                    |
|                                 |                                 |
|  +------------------+  +--------v---------+  +------------------+ |
|  | PermissionManager|  |     EventBus     |  |   TodoManager    | |
|  | (Approval flow)  |  | (3-channel emit) |  | (Task tracking)  | |
|  +------------------+  +------------------+  +------------------+ |
|                                                                   |
+----------------------------------+--------------------------------+
                                   |
                    +--------------+--------------+
                    |              |              |
           +--------v------+ +----v----+ +-------v-------+
           |     Store     | | Sandbox | | ModelProvider |
           | (Persistence) | | (Exec)  | | (LLM calls)   |
           +---------------+ +---------+ +---------------+
```

### Data Flow

```
User Message
     |
     v
+----+----+     +-----------+     +------------+
| Message |---->|  Context  |---->|   Model    |
|  Queue  |     |  Manager  |     |  Provider  |
+---------+     +-----------+     +-----+------+
                                        |
                              +---------+---------+
                              |                   |
                         Text Response      Tool Calls
                              |                   |
                              v                   v
                    +---------+------+    +------+-------+
                    |    EventBus    |    |  ToolRunner  |
                    | (text_chunk)   |    | (parallel)   |
                    +----------------+    +------+-------+
                                                 |
                              +------------------+------------------+
                              |                  |                  |
                         Permission         Execution          Result
                           Check              (Sandbox)        Handling
                              |                  |                  |
                              v                  v                  v
                    +--------------------+  +---------+  +------------------+
                    | PermissionManager  |  | Sandbox |  |    EventBus      |
                    | (Control channel)  |  | (exec)  |  | (tool:complete)  |
                    +--------------------+  +---------+  +------------------+
```

### State Persistence (WAL)

```
Every State Change
        |
        v
+-------+-------+
|  Write-Ahead  |
|     Log       |  <-- Write first (fast, append-only)
+-------+-------+
        |
        v
+-------+-------+
|   Main File   |  <-- Then update (can be slow)
+-------+-------+
        |
        v
+-------+-------+
|  Delete WAL   |  <-- Finally cleanup
+-------+-------+

On Crash Recovery:
1. Scan for WAL files
2. If WAL exists but main file incomplete -> Restore from WAL
3. Delete WAL after successful restore
```

---

## Runtime Characteristics

### Memory Model

```
Agent Memory Footprint (Typical):

+---------------------------+
|     Agent Instance        |
+---------------------------+
| messages[]: 10KB - 2MB    |  <-- Grows with conversation
| toolRecords: 1KB - 100KB  |  <-- Grows with tool usage
| eventTimeline: 5KB - 500KB|  <-- Recent events cached
| mediaCache: 0 - 10MB      |  <-- If images/files involved
| baseObjects: ~50KB        |  <-- Fixed overhead
+---------------------------+

Typical range: 100KB - 5MB per agent
AgentPool (50 agents): 5MB - 250MB
```

### I/O Patterns

```
Per Agent Step:

+-------------------+     +-------------------+     +-------------------+
| persistMessages() |     | persistToolRecs() |     | emitEvents()      |
| ~20-50ms (SSD)    |     | ~5-10ms           |     | ~1-5ms (buffered) |
+-------------------+     +-------------------+     +-------------------+

Total per step: 30-70ms I/O overhead

At Scale (100 concurrent agents):
- Sequential bottleneck in JSONStore
- Need distributed Store for parallel writes
```

### Event Loop Impact

```
Agent Processing:

   +---------+
   |  IDLE   |  <-- Agent waiting for input
   +----+----+
        |
   +----v----+
   | PROCESS |  <-- Model call (async, non-blocking)
   +----+----+
        |
   +----v----+
   |  TOOL   |  <-- Tool execution (may block if sync)
   +----+----+
        |
   +----v----+
   | PERSIST |  <-- File I/O (async)
   +----+----+
        |
        v
   +---------+
   |  IDLE   |
   +---------+

Key: All heavy operations are async
Risk: Sync operations in custom tools can block event loop
```

---

## Deployment Patterns

### Pattern 1: Single Process (CLI/Desktop)

```
+------------------------------------------------------------------+
|                        Your Application                           |
+------------------------------------------------------------------+
|                                                                   |
|   +------------------+                                            |
|   |   KODE SDK       |                                            |
|   |   +----------+   |                                            |
|   |   | Agent(s) |   |                                            |
|   |   +----------+   |                                            |
|   |   | JSONStore|   |  --> Local filesystem                      |
|   |   +----------+   |                                            |
|   +------------------+                                            |
|                                                                   |
+------------------------------------------------------------------+

Best for: CLI tools, Electron apps, VSCode extensions
Agents: 1-50 concurrent
Users: Single user
Persistence: Local files
```

### Pattern 2: Single Server (Self-hosted)

```
+------------------------------------------------------------------+
|                          Server                                   |
+------------------------------------------------------------------+
|                                                                   |
|   +------------------+     +------------------+                   |
|   |   HTTP Layer     |     |   KODE SDK       |                   |
|   |   (Express/etc)  |---->|   AgentPool      |                   |
|   +------------------+     +------------------+                   |
|                                   |                               |
|                            +------v------+                        |
|                            |  JSONStore  |  --> Local filesystem  |
|                            +-------------+                        |
|                                                                   |
+------------------------------------------------------------------+

Best for: Internal tools, small teams, prototypes
Agents: 10-100 concurrent
Users: <100 concurrent
Persistence: Local files (can use Redis/Postgres)
```

### Pattern 3: Worker Microservice (Scalable)

```
+------------------------------------------------------------------+
|                         Load Balancer                             |
+----------------------------------+--------------------------------+
                                   |
         +-------------------------+-------------------------+
         |                         |                         |
+--------v--------+     +----------v--------+     +----------v------+
|   API Server 1  |     |   API Server 2    |     |   API Server N  |
|   (Stateless)   |     |   (Stateless)     |     |   (Stateless)   |
+--------+--------+     +----------+--------+     +----------+------+
         |                         |                         |
         +-------------------------+-------------------------+
                                   |
                          +--------v--------+
                          |  Message Queue  |
                          |  (Redis/SQS)    |
                          +--------+--------+
                                   |
         +-------------------------+-------------------------+
         |                         |                         |
+--------v--------+     +----------v--------+     +----------v------+
|   Worker 1      |     |   Worker 2        |     |   Worker N      |
|   +----------+  |     |   +----------+    |     |   +----------+  |
|   | KODE SDK |  |     |   | KODE SDK |    |     |   | KODE SDK |  |
|   | AgentPool|  |     |   | AgentPool|    |     |   | AgentPool|  |
|   +----------+  |     |   +----------+    |     |   +----------+  |
+--------+--------+     +----------+--------+     +----------+------+
         |                         |                         |
         +-------------------------+-------------------------+
                                   |
                          +--------v--------+
                          | Distributed     |
                          | Store           |
                          | (PostgreSQL)    |
                          +-----------------+

Best for: Production ToC apps, SaaS platforms
Agents: 1000+ concurrent
Users: 10K+ concurrent
Persistence: PostgreSQL/Redis with distributed locks
```

### Pattern 4: Hybrid Serverless (API + Workers)

```
+------------------------------------------------------------------+
|                    Serverless Platform (Vercel)                   |
+------------------------------------------------------------------+
|                                                                   |
|   +------------------+                                            |
|   |  /api/chat       |  --> Validate, enqueue, return task ID    |
|   +------------------+                                            |
|   |  /api/status     |  --> Check task status from DB            |
|   +------------------+                                            |
|   |  /api/stream     |  --> SSE from Redis Pub/Sub               |
|   +------------------+                                            |
|                                                                   |
+----------------------------------+--------------------------------+
                                   |
                          +--------v--------+
                          |  Message Queue  |
                          |  (Upstash Redis)|
                          +--------+--------+
                                   |
+----------------------------------v--------------------------------+
|                    Worker Platform (Railway/Render)               |
+------------------------------------------------------------------+
|                                                                   |
|   +------------------+                                            |
|   |   Worker Pool    |                                            |
|   |   +----------+   |                                            |
|   |   | KODE SDK |   |                                            |
|   |   | Agents   |   |                                            |
|   |   +----------+   |                                            |
|   +------------------+                                            |
|                                                                   |
+------------------------------------------------------------------+

Best for: Serverless frontend + stateful backend
API: Serverless (fast, scalable, cheap)
Agents: Long-running workers (Railway, Render, Fly.io)
```

---

## Scaling Strategies

### Strategy 1: Vertical Scaling (Single Node)

```
Applicable: Up to ~100 concurrent agents

Optimizations:
1. Increase AgentPool maxAgents
2. Use Redis for Store (faster than files)
3. Add memory (agents are memory-bound)
4. Use SSD for persistence

const pool = new AgentPool({
  maxAgents: 100,  // Increase from default 50
  store: new RedisStore({ ... }),
});
```

### Strategy 2: Agent Sharding (Multi-Node)

```
Applicable: 100-1000 concurrent agents

Architecture:
- Hash agentId to determine which worker handles it
- Consistent hashing for minimal reshuffling
- Each worker owns a shard of agents

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

### Strategy 3: Agent Scheduling (LRU)

```
Applicable: 1000+ total agents, limited active

Concept:
- Not all agents are active simultaneously
- Keep hot agents in memory
- Hibernate cold agents to storage
- Resume on demand

class AgentScheduler {
  private active: LRUCache<string, Agent>;  // In memory
  private hibernated: Set<string>;           // In storage

  async get(agentId: string): Promise<Agent> {
    // Check active cache
    if (this.active.has(agentId)) {
      return this.active.get(agentId);
    }

    // Resume from storage
    const agent = await Agent.resume(agentId, config, deps);
    this.active.set(agentId, agent);

    // LRU eviction handles hibernation
    return agent;
  }
}
```

### Strategy 4: Fork Optimization (COW)

```
Applicable: Heavy fork usage (exploration scenarios)

Current: O(n) deep copy of messages
Optimized: O(1) copy-on-write

Before:
  fork() {
    const forked = JSON.parse(JSON.stringify(messages));  // O(n)
  }

After:
  fork() {
    const forkedHead = currentHead;  // O(1) pointer copy
    // Messages are immutable, share until modified
  }
```

---

## Decision Framework

### When to Use KODE SDK Directly

```
+------------------+
|  Decision Tree   |
+------------------+
         |
         v
+------------------+
| Single user/     |----YES---> Use directly (Pattern 1)
| local machine?   |
+--------+---------+
         | NO
         v
+------------------+
| < 100 concurrent |----YES---> Single server (Pattern 2)
| users?           |
+--------+---------+
         | NO
         v
+------------------+
| Can run long-    |----YES---> Worker microservice (Pattern 3)
| running processes?|
+--------+---------+
         | NO
         v
+------------------+
| Serverless only? |----YES---> Hybrid pattern (Pattern 4)
+--------+---------+
         | NO
         v
+------------------+
| Consider other   |
| solutions        |
+------------------+
```

### Platform Compatibility Matrix

| Platform | Compatible | Notes |
|----------|------------|-------|
| Node.js | 100% | Primary target |
| Bun | 95% | Minor adjustments needed |
| Deno | 80% | Permission flags required |
| Electron | 90% | Use in main process |
| VSCode Extension | 85% | workspace.fs integration |
| Vercel Functions | 20% | API layer only, not agents |
| Cloudflare Workers | 5% | Not compatible |
| Browser | 10% | No fs/process, very limited |

### Store Selection Guide

| Store | Use Case | Throughput | Scaling |
|-------|----------|------------|---------|
| JSONStore | Development, CLI | Low | Single node |
| SQLiteStore | Desktop apps | Medium | Single node |
| RedisStore | Small-medium production | High | Single node |
| PostgresStore | Production, multi-node | High | Multi-node |

---

## Summary

### Core Principles

1. **KODE SDK is a runtime kernel** - It manages agent lifecycle, not application infrastructure

2. **Agents are stateful** - They need persistent storage and long-running processes

3. **Scale through architecture** - Use worker patterns for large-scale deployments

4. **Store is pluggable** - Implement custom Store for your infrastructure

### Quick Reference

| Scenario | Pattern | Store | Scale |
|----------|---------|-------|-------|
| CLI tool | Single Process | JSONStore | 1 user |
| Desktop app | Single Process | SQLiteStore | 1 user |
| Internal tool | Single Server | RedisStore | ~100 users |
| SaaS product | Worker Microservice | PostgresStore | 10K+ users |
| Serverless app | Hybrid | External DB | Varies |

---

*Next: See [Deployment Guide](./DEPLOYMENT.md) for implementation details.*
