# KODE SDK Roadmap

> This document outlines the development roadmap for KODE SDK, based on actual current capabilities and planned enhancements.

---

## Current State (v2.7.0)

### What Works Well

| Feature | Status | Notes |
|---------|--------|-------|
| Agent State Machine | Stable | 7-stage breakpoint system |
| JSONStore | Stable | WAL-protected file persistence |
| Event System | Stable | 3 channels (Progress/Control/Monitor) |
| Fork/Resume | Stable | Safe fork points, crash recovery |
| Multi-provider | Stable | Anthropic, OpenAI, Gemini, DeepSeek, Qwen, GLM... |
| Tool System | Stable | Built-in + MCP protocol |
| AgentPool | Stable | Up to 50 agents per process |
| Checkpointer | Stable | Memory, File, Redis implementations |
| Context Compression | Stable | Automatic history management |
| Hook System | Stable | Pre/post model and tool hooks |

### Current Limitations

| Limitation | Impact | Workaround |
|------------|--------|------------|
| JSONStore only | No database persistence | Implement custom Store |
| Single-process pool | No distributed scaling | Build orchestration layer |
| 5-min processing timeout | Not configurable | Fork SDK if needed |
| No stateless mode | Serverless challenges | Request-scoped pattern |
| No distributed locking | Multi-instance conflicts | External coordination |

---

## Short-term: v2.8 - v2.9 (Q1-Q2 2025)

### v2.8: Store Improvements

**Goal**: Make custom Store implementation easier and more robust.

| Feature | Priority | Description |
|---------|----------|-------------|
| Store interface documentation | P0 | Comprehensive guide for implementing custom stores |
| Store validation utilities | P1 | Test helpers to verify Store implementations |
| Incremental message API | P1 | `appendMessage()` in addition to `saveMessages()` |
| Store migration utilities | P2 | Tools for migrating data between Store implementations |

**New APIs:**
```typescript
// Optional incremental methods (backwards compatible)
interface Store {
  // Existing methods...

  // NEW: Incremental append (optional, for performance)
  appendMessage?(agentId: string, message: Message): Promise<void>;

  // NEW: Paginated loading (optional, for large histories)
  loadMessagesPaginated?(agentId: string, opts: {
    offset: number;
    limit: number;
  }): Promise<Message[]>;
}
```

### v2.9: Configurable Limits

**Goal**: Remove hard-coded limits, improve serverless compatibility.

| Feature | Priority | Description |
|---------|----------|-------------|
| Configurable processing timeout | P0 | Currently hard-coded to 5 minutes |
| Configurable tool buffer size | P1 | Currently hard-coded to 10 MB |
| Pool size validation | P2 | Better error messages when exceeding limits |

**New APIs:**
```typescript
// Agent configuration
const agent = await Agent.create({
  agentId: 'my-agent',
  templateId: 'default',
  // NEW: Runtime limits
  limits: {
    processingTimeout: 30_000,  // 30 seconds for serverless
    toolBufferSize: 5 * 1024 * 1024,  // 5 MB
  },
}, dependencies);
```

---

## Mid-term: v3.0 (Q3 2025)

### v3.0: Official Store Implementations

**Goal**: Provide production-ready Store implementations for common databases.

| Store | Priority | Dependencies |
|-------|----------|--------------|
| `@kode-sdk/store-postgres` | P0 | `pg` |
| `@kode-sdk/store-redis` | P0 | `ioredis` |
| `@kode-sdk/store-supabase` | P1 | `@supabase/supabase-js` |
| `@kode-sdk/store-dynamodb` | P2 | `@aws-sdk/client-dynamodb` |

**Package Structure:**
```
@kode-sdk/store-postgres
├── src/
│   ├── index.ts
│   ├── postgres-store.ts
│   └── schema.sql
├── README.md
└── package.json
```

**Features:**
- Complete Store interface implementation
- Schema migration utilities
- Connection pooling
- Retry logic for transient failures
- Distributed locking support

### v3.0: Stateless Execution Mode

**Goal**: Native support for serverless environments.

```typescript
// NEW: Request-scoped execution
import { StatelessAgent } from '@shareai-lab/kode-sdk';

export async function POST(req: Request) {
  const { agentId, message } = await req.json();

  // Automatically handles: load → execute → persist
  const result = await StatelessAgent.run(agentId, message, {
    store: postgresStore,
    templateId: 'default',
    timeout: 25_000,
  });

  return Response.json(result);
}
```

**Key Features:**
- Automatic state loading and persisting
- Timeout handling with graceful shutdown
- No in-memory pool required
- Optimized for cold starts

---

## Long-term: v4.0+ (2026)

### v4.0: Distributed Infrastructure (Optional Package)

**Goal**: Official distributed coordination package for high-scale deployments.

```
@kode-sdk/distributed
├── scheduler/      # Agent scheduling across workers
├── discovery/      # Agent location discovery
├── locking/        # Distributed locking
└── migration/      # Agent migration between nodes
```

**Features:**
```typescript
import { DistributedPool } from '@kode-sdk/distributed';

const pool = new DistributedPool({
  store: postgresStore,
  redis: redisClient,
  workerId: process.env.WORKER_ID,
  maxLocalAgents: 50,
});

// Agent automatically migrates between workers
const agent = await pool.acquire(agentId);
await agent.send(message);
await agent.complete();
await pool.release(agentId);
```

### v4.0: Observability Integration

**Goal**: First-class observability support.

```typescript
import { OpenTelemetryPlugin } from '@kode-sdk/observability';

const agent = await Agent.create({
  agentId: 'my-agent',
  templateId: 'default',
  plugins: [
    new OpenTelemetryPlugin({
      serviceName: 'my-agent-service',
      tracing: true,
      metrics: true,
    }),
  ],
}, dependencies);
```

**Metrics:**
- `agent.step.duration` - Time per agent step
- `agent.tool.duration` - Time per tool execution
- `agent.model.tokens` - Token usage
- `agent.errors` - Error count by type

### v4.x: Additional Sandboxes

| Sandbox | Status | Description |
|---------|--------|-------------|
| `DockerSandbox` | Planned | Run tools in Docker containers |
| `K8sSandbox` | Planned | Run tools in Kubernetes pods |
| `E2BSandbox` | Planned | Integration with E2B.dev |
| `FirecrackerSandbox` | Exploring | MicroVM isolation |

---

## Community Contributions Welcome

### High-Impact Contributions

1. **Store Implementations**
   - MongoDB Store
   - SQLite Store (for embedded use)
   - Turso/LibSQL Store

2. **Sandbox Implementations**
   - Docker Sandbox
   - WebContainer Sandbox (browser)

3. **Tool Integrations**
   - Browser automation (Playwright)
   - Database clients
   - Cloud service SDKs

### Contribution Guidelines

See [CONTRIBUTING.md](./CONTRIBUTING.md) for:
- Code style and testing requirements
- Pull request process
- Interface implementation guidelines

---

## Version Support Policy

| Version | Status | Support Until |
|---------|--------|---------------|
| v2.7.x | Current | Active development |
| v2.6.x | Maintenance | 6 months after v2.8 |
| v2.5.x | End of Life | No longer supported |

**Semver Policy:**
- Major (v3, v4): Breaking changes to core APIs
- Minor (v2.8, v2.9): New features, backwards compatible
- Patch (v2.7.1): Bug fixes only

---

## Feedback & Prioritization

Roadmap priorities are influenced by:

1. **GitHub Issues**: Feature requests with most reactions
2. **Community Discussions**: Patterns emerging from usage
3. **Production Feedback**: Real-world deployment challenges

To influence the roadmap:
- Open or upvote GitHub Issues
- Share your use case in Discussions
- Contribute implementations for planned features

---

## Timeline Summary

```
2025 Q1-Q2: v2.8-v2.9
├── Store interface improvements
├── Configurable limits
└── Better serverless support

2025 Q3: v3.0
├── Official Store packages (Postgres, Redis, Supabase)
├── Stateless execution mode
└── Improved documentation

2026: v4.0+
├── Distributed infrastructure package
├── Observability integration
└── Additional sandbox implementations
```

The roadmap focuses on:
1. **Making extension easier** (v2.8-2.9)
2. **Providing official implementations** (v3.0)
3. **Scaling infrastructure** (v4.0+)

Core philosophy remains: **KODE SDK is a runtime kernel, not a platform.** Official packages extend capabilities without bloating the core.
