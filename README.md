# KODE SDK

[English](./README.md) | [中文](./README.zh-CN.md)

> Event-driven, long-running AI Agent framework with enterprise-grade persistence and multi-agent collaboration.

## Features

- **Event-Driven Architecture** - Three-channel system (Progress/Control/Monitor) for clean separation of concerns
- **Long-Running & Resumable** - Seven-stage checkpoints with Safe-Fork-Point for crash recovery
- **Multi-Agent Collaboration** - AgentPool, Room messaging, and task delegation
- **Enterprise Persistence** - SQLite/PostgreSQL support with unified WAL
- **Cloud Sandbox** - [E2B](https://e2b.dev) and OpenSandbox integration for isolated remote code execution
- **Extensible Ecosystem** - MCP tools, custom Providers, Skills system

## Quick Start

**One-liner setup** (install dependencies and build):

```bash
./quickstart.sh
```

Or install as a dependency:

```bash
npm install @shareai-lab/kode-sdk
```

Set environment variables:

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export ANTHROPIC_API_KEY=sk-...
export ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514  # optional, default: claude-sonnet-4-20250514
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # optional, default: https://api.anthropic.com
```

#### **Windows (PowerShell)**
```powershell
$env:ANTHROPIC_API_KEY="sk-..."
$env:ANTHROPIC_MODEL_ID="claude-sonnet-4-20250514"  # optional, default: claude-sonnet-4-20250514
$env:ANTHROPIC_BASE_URL="https://api.anthropic.com"  # optional, default: https://api.anthropic.com
```
<!-- tabs:end -->

Minimal example:

```typescript
import { Agent, AnthropicProvider, JSONStore } from '@shareai-lab/kode-sdk';

const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  process.env.ANTHROPIC_MODEL_ID
);

const agent = await Agent.create({
  provider,
  store: new JSONStore('./.kode'),
  systemPrompt: 'You are a helpful assistant.'
});

// Subscribe to progress events
for await (const envelope of agent.subscribe(['progress'])) {
  if (envelope.event.type === 'text_chunk') {
    process.stdout.write(envelope.event.delta);
  }
  if (envelope.event.type === 'done') break;
}

await agent.send('Hello!');
```

Run examples:

```bash
npm run example:getting-started    # Minimal chat
npm run example:agent-inbox        # Event-driven inbox
npm run example:approval           # Tool approval workflow
npm run example:room               # Multi-agent collaboration
npm run example:opensandbox        # OpenSandbox basic usage
```

OpenSandbox quick config:

```bash
export OPEN_SANDBOX_API_KEY=...                      # optional (required only when auth is enabled)
export OPEN_SANDBOX_ENDPOINT=http://127.0.0.1:8080  # optional
export OPEN_SANDBOX_IMAGE=ubuntu                     # optional
```

## Observability

KODE keeps observability as an SDK-facing capability first:

- runtime metrics via `agent.getMetricsSnapshot()`
- runtime observations via `agent.getObservationReader()` / `agent.subscribeObservations()`
- optional OTEL bridge via `observability.otel`
- optional persisted observation query via `observability.persistence`

Minimal persisted-observation example:

```typescript
import {
  Agent,
  JSONStore,
  JSONStoreObservationBackend,
  createStoreBackedObservationReader,
} from '@shareai-lab/kode-sdk';

const storeDir = './.kode';
const observationBackend = new JSONStoreObservationBackend(storeDir);

const agent = await Agent.create({
  templateId: 'assistant',
  observability: {
    persistence: {
      backend: observationBackend,
    },
  },
}, deps);

const runtimeSnapshot = agent.getMetricsSnapshot();
const runtimeObservations = agent.getObservationReader().listObservations();

const persistedReader = createStoreBackedObservationReader(observationBackend);
const persistedObservations = await persistedReader.listObservations({ limit: 50 });
```

If you want to expose these metrics or observations over HTTP, do it in your application on top of readers/backends, not inside `Agent` itself. `examples/08-observability-http.ts` is an application-layer example, not an SDK-owned HTTP feature.

Run the full example locally with `npm run example:observability-http`.

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

See [docs/en/guides/architecture.md](./docs/en/guides/architecture.md) for detailed deployment guides.

## Supported Providers

| Provider | Streaming | Tools | Reasoning | Files |
|----------|-----------|-------|-----------|-------|
| Anthropic | ✅ | ✅ | ✅ Extended Thinking | ✅ |
| OpenAI | ✅ | ✅ | ✅ | ✅ |
| Gemini | ✅ | ✅ | ✅ | ✅ |

> **Note**: OpenAI-compatible services (DeepSeek, GLM, Qwen, Minimax, OpenRouter, etc.) can be used via `OpenAIProvider` with custom `baseURL` configuration. See [Providers Guide](./docs/en/guides/providers.md) for details.

## Documentation

| Section | Description |
|---------|-------------|
| **Getting Started** | |
| [Installation](./docs/en/getting-started/installation.md) | Setup and configuration |
| [Quickstart](./docs/en/getting-started/quickstart.md) | Build your first Agent |
| [Concepts](./docs/en/getting-started/concepts.md) | Core concepts explained |
| **Guides** | |
| [Events](./docs/en/guides/events.md) | Three-channel event system |
| [Observability](./docs/en/guides/observability.md) | Metrics, observations, persistence, and app-layer exposure |
| [Tools](./docs/en/guides/tools.md) | Built-in tools & custom tools |
| [E2B Sandbox](./docs/en/guides/e2b-sandbox.md) | E2B cloud sandbox integration |
| [OpenSandbox](./docs/en/guides/opensandbox-sandbox.md) | OpenSandbox self-hosted sandbox integration |
| [Skills](./docs/en/guides/skills.md) | Skills system for reusable prompts |
| [Providers](./docs/en/guides/providers.md) | Model provider configuration |
| [Database](./docs/en/guides/database.md) | SQLite/PostgreSQL persistence |
| [Resume & Fork](./docs/en/guides/resume-fork.md) | Crash recovery & branching |
| **Project** | |
| [Contribution Guide](./docs/en/contribution.md) | How to contribute |
| **Reference** | |
| [API Reference](./docs/en/reference/api.md) | Complete API documentation |
| [Examples](./docs/en/examples/playbooks.md) | All examples explained |

## License

MIT
