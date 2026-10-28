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

Current `main` includes unreleased lifecycle corrections described below. As of 2026-10-25, npm `latest` is 2.7.5 and does not include these changes. Use the source checkout to evaluate them; npm installation alone does not validate the current source.

Requires **Node.js 20.18.1–20.x or 22.x–25.x** (the range supported by the current native SQLite dependency). Choose either a source checkout or a new application.

### Run from this repository

```bash
git clone https://github.com/shareAI-lab/kode-agent-sdk.git
cd kode-agent-sdk
npm ci
npm run build
npm run example:getting-started -- --mock
```

The mock run is offline, needs no credentials, and prints a deterministic response. `./quickstart.sh` installs locked dependencies and builds from a checkout; it does not call a model. All `example:*` scripts run from the repository root. For a real request, set `ANTHROPIC_API_KEY` and run `npm run example:getting-started` without `--mock`.

### Use the published package

```bash
npm install @shareai-lab/kode-sdk
npm install --save-dev typescript ts-node @types/node
```

Save this configuration as `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "Node16",
    "moduleResolution": "node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

Set your own provider credentials in the terminal (model and base URL are passed explicitly to the provider):

```bash
export ANTHROPIC_API_KEY=your-key
export ANTHROPIC_MODEL_ID=claude-sonnet-4-5-20250929  # example model ID; choose one available to your account
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # optional
```

On Windows PowerShell use `$env:ANTHROPIC_API_KEY="your-key"` and the same syntax for the other variables.

Save the following as `getting-started.ts`, then run `npx ts-node getting-started.ts`. This sends a real model request and may incur usage charges.

<!-- runnable:getting-started -->
```typescript
import {
  Agent, AnthropicProvider, JSONStore, AgentTemplateRegistry,
  ToolRegistry, SandboxFactory, LocalSandbox,
} from '@shareai-lab/kode-sdk';

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY before running this example.');
  const provider = new AnthropicProvider(
    apiKey,
    process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-5-20250929',
    process.env.ANTHROPIC_BASE_URL
  );
  const templates = new AgentTemplateRegistry();
  templates.register({ id: 'assistant', systemPrompt: 'You are a helpful assistant.' });
  const sandbox = new LocalSandbox({ workDir: './workspace', enforceBoundary: true, watchFiles: false });
  try {
    const agent = await Agent.create(
      { templateId: 'assistant', model: provider, sandbox },
      {
        store: new JSONStore('./.kode'),
        templateRegistry: templates,
        toolRegistry: new ToolRegistry(),
        sandboxFactory: new SandboxFactory(),
        modelFactory: () => provider,
      }
    );
    for await (const { event } of agent.chatStream('Hello!')) {
      if (event.type === 'text_chunk') process.stdout.write(event.delta);
    }
    console.log();
  } finally {
    await sandbox.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

`Agent.create(config, deps)` requires both arguments and a registered template. `chatStream(input)` sends and consumes one turn, ending on `done`; errors reject the iterator. `send()` only enqueues a message and returns its ID. Overlapping `chat()` / `chatStream()` calls on one agent reject before enqueueing; await the current turn first. With `subscribe()`, start the consumer before `send()` and await both tasks; the subscription remains open until you break or return its iterator.

The application owns the sandbox and closes it in `finally`. When using tools with approval, register Control listeners before sending; see [Events](docs/en/guides/events.md). For persistence use JSONStore, SQLite or PostgreSQL; see [Database](docs/en/guides/database.md). SQLite is a native dependency and may require build tools if no prebuilt binary matches your Node/platform.

```bash
npm run test:onboarding     # Offline public-API lifecycle checks
npm run test:quickstart     # Offline setup-script regression tests
npm run test:package        # Build, pack locally, check CJS/ESM/types and runnable documentation
npm run typecheck:examples  # Run after build
```

Other examples (real services or model access may be required):

```bash
npm run example:agent-inbox
npm run example:approval
npm run example:room
npm run example:opensandbox
```

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
                        | Distributed Store|  PostgreSQL / custom Store
                        +------------------+
```

**Key Principles:**
1. **API layer is stateless** - Can run on serverless
2. **Workers are stateful** - Run KODE SDK, need long-running processes
3. **Store is shared** - Single source of truth for agent state
4. **Queue decouples** - Request handling from agent execution

See [docs/en/advanced/architecture.md](./docs/en/advanced/architecture.md) for detailed deployment guides.

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
