# Architecture Guide

> Deep dive into the mental model, design decisions, and runtime characteristics of KODE SDK.

---

## Table of Contents

1. [Mental Model](#mental-model)
2. [Core Architecture](#core-architecture)
3. [Runtime Characteristics](#runtime-characteristics)
4. [Decision Framework](#decision-framework)

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
|                    |    BreakpointManager    |                    |
|                    |   (8-stage state track) |                    |
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

### Key Classes & Interfaces

| Component | Class | Description |
|-----------|-------|-------------|
| Agent | `Agent` | Core orchestrator for conversations and tool execution |
| Pool | `AgentPool` | Manages multiple Agent instances with lifecycle control |
| Room | `Room` | Multi-agent messaging and collaboration |
| Store | `Store`, `JSONStore`, `SqliteStore`, `PostgresStore` | Persistence backends |
| Sandbox | `LocalSandbox` | Local file access with path checks and host-user shell execution; no OS isolation |
| Provider | `AnthropicProvider`, `OpenAIProvider`, `GeminiProvider` | LLM API adapters |
| Events | `EventBus` | Three-channel event distribution |
| Hooks | `HookManager` | Pre/post execution interception |

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
                    | (Control channel)  |  | (exec)  |  | (tool:end)       |
                    +--------------------+  +---------+  +------------------+
```

### Breakpoint State Machine

The `BreakpointManager` tracks 8 states for crash recovery:

```
Agent Execution Flow:

  READY -> PRE_MODEL -> STREAMING_MODEL -> TOOL_PENDING -> AWAITING_APPROVAL
    |         |              |                 |                |
    +-------- WAL Protected State -------------+-- Approval ----+
                                                                |
                        +---------------------------------------+
                        |
                        v
            PRE_TOOL -> TOOL_EXECUTING -> POST_TOOL -> READY
                |             |              |
                +---- Tool Execution --------+

On crash: Resume from last safe breakpoint, auto-seal incomplete tool calls
```

**BreakpointState Values** (from `src/core/types.ts:69`):
- `READY` - Agent idle, waiting for input
- `PRE_MODEL` - About to call LLM
- `STREAMING_MODEL` - Receiving LLM response
- `TOOL_PENDING` - Tool calls parsed, awaiting execution
- `AWAITING_APPROVAL` - Waiting for permission decision
- `PRE_TOOL` - About to execute tool
- `TOOL_EXECUTING` - Tool running
- `POST_TOOL` - Tool completed, processing result

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

### Three-Channel Event System

```
+-------------+     +-------------+     +-------------+
|  Progress   |     |   Control   |     |   Monitor   |
+-------------+     +-------------+     +-------------+
| text_chunk  |     | permission  |     | state_changed|
| tool:start  |     | _required   |     | token_usage |
| tool:end    |     | permission  |     | tool_executed|
| done        |     | _decided    |     | error       |
+-------------+     +-------------+     +-------------+
      |                   |                   |
      v                   v                   v
   Your UI         Approval Service     Observability
```

**Usage Pattern:**

```typescript
// Progress: Real-time streaming for UI
for await (const envelope of agent.subscribe(['progress'])) {
  if (envelope.event.type === 'text_chunk') {
    process.stdout.write(envelope.event.delta);
  }
}

// Control: Approval workflow
agent.on('permission_required', async (event) => {
  await event.respond('allow');
});

// Monitor: Observability
agent.on('token_usage', (event) => {
  console.log('Tokens:', event.totalTokens);
});
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
- Need SqliteStore/PostgresStore for parallel writes
```

### Event Loop Impact

```
Agent Processing:

   +---------+
   |  READY  |  <-- Agent waiting for input
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
   |  READY  |
   +---------+

Key: All heavy operations are async
Risk: Sync operations in custom tools can block event loop
```

---

## Decision Framework

### When to Use KODE SDK

```
+------------------+
|  Decision Tree   |
+------------------+
         |
         v
+------------------+
| Single user/     |----YES---> Use directly (CLI/Desktop)
| local machine?   |
+--------+---------+
         | NO
         v
+------------------+
| < 100 concurrent |----YES---> Single server (AgentPool)
| users?           |
+--------+---------+
         | NO
         v
+------------------+
| Can run long-    |----YES---> Worker microservice pattern
| running processes?|
+--------+---------+
         | NO
         v
+------------------+
| Serverless only? |----YES---> Hybrid pattern (API + Workers)
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
| `JSONStore` | Development, CLI | Low | Single node |
| `SqliteStore` | Desktop apps, small server | Medium | Single node |
| `PostgresStore` | Production, multi-node | High | Multi-node |

**Store Interface Hierarchy** (from `src/infra/store/types.ts`):

```
Store (base)
  └── QueryableStore (adds query methods)
        └── ExtendedStore (adds health check, metrics, distributed lock)
```

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
| Desktop app | Single Process | SqliteStore | 1 user |
| Internal tool | Single Server | SqliteStore/PostgresStore | ~100 users |
| SaaS product | Worker Microservice | PostgresStore | 10K+ users |
| Serverless app | Hybrid | External DB | Varies |

---

*See also: [Production Deployment](./production.md) | [Database Guide](../guides/database.md)*
