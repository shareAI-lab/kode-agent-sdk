# KODE SDK

> **Stateful Agent Runtime Kernel** - The engine that powers your AI agents with persistence, recovery, and trajectory exploration.

```
                    +------------------+
                    |   Your App       |  CLI / Desktop / IDE / Server
                    +--------+---------+
                             |
                    +--------v---------+
                    |    KODE SDK      |  Agent Runtime Kernel
                    |  +-----------+   |
                    |  |  Agent    |   |  Lifecycle + State + Events
                    |  +-----------+   |
                    |  |  Store    |   |  Persistence (Pluggable)
                    |  +-----------+   |
                    |  |  Sandbox  |   |  Execution Isolation
                    |  +-----------+   |
                    +------------------+
```

---

## What is KODE SDK?

KODE SDK is an **Agent Runtime Kernel** - think of it like V8 for JavaScript, but for AI agents. It handles the complex lifecycle management so you can focus on building your agent's capabilities.

**Core Capabilities:**
- **Crash Recovery**: WAL-protected persistence with 7-stage breakpoint recovery
- **Fork & Resume**: Explore different agent trajectories from any checkpoint
- **Event Streams**: Progress/Control/Monitor channels for real-time UI updates
- **Tool Governance**: Permission system, approval workflows, audit trails

**What KODE SDK is NOT:**
- Not a cloud platform (you deploy it)
- Not an HTTP server (you add that layer)
- Not a multi-tenant SaaS framework (you build that on top)

---

## When to Use KODE SDK

### Perfect Fit (Use directly)

| Scenario | Why It Works |
|----------|--------------|
| **CLI Agent Tools** | Single process, local filesystem, zero config |
| **Desktop Apps** (Electron/Tauri) | Full system access, long-running process |
| **IDE Plugins** (VSCode/JetBrains) | Single user, workspace integration |
| **Local Development** | Fast iteration, instant persistence |

### Good Fit (With architecture)

| Scenario | What You Need |
|----------|---------------|
| **Self-hosted Server** | Add HTTP layer (Express/Fastify/Hono) |
| **Small-scale Backend** (<1K users) | Implement PostgresStore, add user isolation |
| **Kubernetes Deployment** | Implement distributed Store + locks |

### Needs Custom Architecture

| Scenario | Recommended Approach |
|----------|---------------------|
| **Large-scale ToC** (10K+ users) | Worker microservice pattern (see [Architecture Guide](./docs/ARCHITECTURE.md)) |
| **Serverless** (Vercel/Cloudflare) | API layer on serverless + Worker pool for agents |
| **Multi-tenant SaaS** | Tenant isolation layer + distributed Store |

### Not Designed For

| Scenario | Reason |
|----------|--------|
| **Pure browser runtime** | No filesystem, no process execution |
| **Edge functions only** | Agent loops need long-running processes |
| **Stateless microservices** | Agents are inherently stateful |

> **Rule of Thumb**: If your agents need to run for more than a few seconds, execute tools, and remember state - KODE SDK is for you. If you just need stateless LLM calls, use the provider APIs directly.

---

## 60-Second Quick Start

```bash
npm install @anthropic/kode-sdk

# Set your API key
export ANTHROPIC_API_KEY=sk-...

# Run the example
npx ts-node examples/getting-started.ts
```

```typescript
import { Agent, AnthropicProvider, LocalSandbox } from '@anthropic/kode-sdk';

const agent = await Agent.create({
  agentId: 'my-first-agent',
  template: { systemPrompt: 'You are a helpful assistant.' },
  deps: {
    modelProvider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY!),
    sandbox: new LocalSandbox({ workDir: './workspace' }),
  },
});

// Subscribe to events
agent.subscribeProgress({ kinds: ['text_chunk'] }, (event) => {
  process.stdout.write(event.text);
});

// Chat with the agent
await agent.chat('Hello! What can you help me with?');
```

---

## Core Concepts

### 1. Three-Channel Event System

```
+-------------+     +-------------+     +-------------+
|  Progress   |     |   Control   |     |   Monitor   |
+-------------+     +-------------+     +-------------+
| text_chunk  |     | permission  |     | tool_audit  |
| tool:start  |     | _required   |     | state_change|
| tool:complete|    | approval    |     | token_usage |
| done        |     | _response   |     | error       |
+-------------+     +-------------+     +-------------+
      |                   |                   |
      v                   v                   v
   Your UI         Approval Service     Observability
```

### 2. Crash Recovery & Breakpoints

```
Agent Execution Flow:

  READY -> PRE_MODEL -> STREAMING -> TOOL_PENDING -> PRE_TOOL -> EXECUTING -> POST_TOOL
    |         |            |             |              |           |           |
    +-------- WAL Protected State -------+-- Approval --+---- Tool Execution ---+

On crash: Resume from last safe breakpoint, auto-seal incomplete tool calls
```

### 3. Fork & Trajectory Exploration

```typescript
// Create a checkpoint at current state
const checkpointId = await agent.checkpoint('before-decision');

// Fork to explore different paths
const explorerA = await agent.fork(checkpointId);
const explorerB = await agent.fork(checkpointId);

await explorerA.chat('Try approach A');
await explorerB.chat('Try approach B');
```

---

## Examples

| Example | Description | Key Features |
|---------|-------------|--------------|
| `npm run example:getting-started` | Minimal chat loop | Progress stream, basic setup |
| `npm run example:agent-inbox` | Event-driven inbox | Todo management, tool concurrency |
| `npm run example:approval` | Approval workflow | Control channel, hooks, policies |
| `npm run example:room` | Multi-agent collaboration | AgentPool, Room, Fork |
| `npm run example:scheduler` | Long-running with reminders | Scheduler, step triggers |
| `npm run example:nextjs` | Next.js API integration | Resume-or-create, SSE streaming |

---

## Architecture for Scale

For production deployments serving many users, we recommend the **Worker Microservice Pattern**:

```
                        +------------------+
                        |    Frontend      |  Next.js / SvelteKit (Vercel OK)
                        +--------+---------+
                                 |
                        +--------v---------+
                        |   API Gateway    |  Auth, routing, queue push
                        +--------+---------+
                                 |
                        +--------v---------+
                        |  Message Queue   |  Redis / SQS / NATS
                        +--------+---------+
                                 |
            +--------------------+--------------------+
            |                    |                    |
   +--------v-------+   +--------v-------+   +--------v-------+
   |   Worker 1     |   |   Worker 2     |   |   Worker N     |
   | (KODE SDK)     |   | (KODE SDK)     |   | (KODE SDK)     |
   | Long-running   |   | Long-running   |   | Long-running   |
   +--------+-------+   +--------+-------+   +--------+-------+
            |                    |                    |
            +--------------------+--------------------+
                                 |
                        +--------v---------+
                        | Distributed Store|  PostgreSQL / Redis
                        +------------------+
```

**Key Principles:**
1. **API layer is stateless** - Can run on serverless
2. **Workers are stateful** - Run KODE SDK, need long-running processes
3. **Store is shared** - Single source of truth for agent state
4. **Queue decouples** - Request handling from agent execution

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for detailed deployment guides.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture Guide](./docs/ARCHITECTURE.md) | Mental model, deployment patterns, scaling strategies |
| [Quickstart](./docs/quickstart.md) | Step-by-step first agent |
| [Events System](./docs/events.md) | Three-channel event model |
| [API Reference](./docs/api.md) | Core types and interfaces |
| [Playbooks](./docs/playbooks.md) | Common patterns and recipes |
| [Deployment](./docs/DEPLOYMENT.md) | Production deployment guide |
| [Roadmap](./docs/ROADMAP.md) | Future development plans |

### Scenario Guides

| Scenario | Guide |
|----------|-------|
| CLI Tools | [docs/scenarios/cli-tools.md](./docs/scenarios/cli-tools.md) |
| Desktop Apps | [docs/scenarios/desktop-apps.md](./docs/scenarios/desktop-apps.md) |
| IDE Plugins | [docs/scenarios/ide-plugins.md](./docs/scenarios/ide-plugins.md) |
| Web Backend | [docs/scenarios/web-backend.md](./docs/scenarios/web-backend.md) |
| Large-scale ToC | [docs/scenarios/large-scale-toc.md](./docs/scenarios/large-scale-toc.md) |

---

## Supported Providers

| Provider | Streaming | Tool Calling | Thinking/Reasoning |
|----------|-----------|--------------|-------------------|
| **Anthropic** | SSE | Native | Extended Thinking |
| **OpenAI** | SSE | Function Calling | o1/o3 reasoning |
| **Gemini** | SSE | Function Calling | thinkingLevel |
| **DeepSeek** | SSE | OpenAI-compatible | reasoning_content |
| **Qwen** | SSE | OpenAI-compatible | thinking_budget |
| **Groq/Cerebras** | SSE | OpenAI-compatible | - |

---

## Roadmap

### v2.8 - Storage Foundation
- PostgresStore with connection pooling
- Distributed locking (Advisory Lock)
- Graceful shutdown support

### v3.0 - Performance
- Incremental message storage (append-only)
- Copy-on-Write fork optimization
- Event sampling and aggregation

### v3.5 - Distributed
- Agent Scheduler with LRU caching
- Distributed EventBus (Redis Pub/Sub)
- Worker mode helpers

See [docs/ROADMAP.md](./docs/ROADMAP.md) for the complete roadmap.

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](./LICENSE) for details.

---

**KODE SDK** - *The runtime kernel that lets you build agents that persist, recover, and explore.*
