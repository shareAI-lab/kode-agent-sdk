# Quickstart

Start with the offline example from the repository root:

```bash
npm ci
npm run build
npm run example:getting-started -- --mock
```

For an application installed from npm, follow [Installation](./installation.md), save this complete example as `getting-started.ts`, and run `npx ts-node getting-started.ts`. Set `ANTHROPIC_API_KEY` first. This path calls a real model; the mock command above does not.

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

## Send and consume events

`chatStream()` sends one input and consumes progress through completion. It releases its subscription when exhausted or when the caller breaks. `chat()` returns the final reply. Both reject on model execution errors. A `kinds` filter can omit `done` from output without preventing the iterator from ending.

`send()` only enqueues and returns a message ID; it does not wait for the reply. A raw subscription must run concurrently:

```typescript
const progress = (async () => {
  for await (const { event } of agent.subscribe(['progress'])) {
    if (event.type === 'text_chunk') process.stdout.write(event.delta);
    if (event.type === 'done') break;
  }
})();
await agent.send('Hello!');
await progress;
```

An agent accepts one active `chat()` / `chatStream()` at a time; an overlapping call rejects before its input is enqueued. Await the current turn first. Completion events describe turns, not message IDs. For application queues, use `send()` with one long-lived consumer.

## Approval, interruption and recovery

Register `permission_required` before sending when the template requires approval. `chat()` remains pending while a decision is outstanding; it does not immediately return `paused`. Call `event.respond('allow' | 'deny')` or `agent.decide(callId, decision)` exactly once. See [Events](../guides/events.md).

`await agent.interrupt()` cancels queued tools, denies outstanding approvals and signals active tools. Consume the terminal `done` event or await the current chat task before reusing the agent or disposing its sandbox. Provider cancellation is cooperative: a provider blocked waiting for network data may not stop until it yields. Interruption cannot roll back tool side effects.

Save `agent.agentId`. Recreate dependencies and register the same template/tools, then call `Agent.resumeFromStore(id, deps, { autoRun: false, strategy: 'crash' })`. Rebind callbacks before sending the next request. See [Resume / Fork](../guides/resume-fork.md).

LocalSandbox file APIs check paths and symbolic-link targets against the configured root and allowPaths. With boundaries enabled, glob does not follow directory symlinks. LocalSandbox shell commands still run with the host user’s permissions: it is not operating-system isolation for untrusted code, and path checks do not eliminate concurrent filesystem races. Use an independently isolated sandbox when that separation is required.

## Resource ownership

File watching combines native notifications with a 250 ms stat check to cover missed notifications and exhausted native watcher limits. Changes can be coalesced; this is not an audit log. Call `unwatchFiles(id)` or dispose the owning sandbox to stop both mechanisms.

The example owns its `LocalSandbox` and disposes it in `finally`. Stop application-created TimeBridge timers with `dispose()`, clear scheduler tasks with `agent.schedule().clear()`, call returned `on()` unsubscribe functions, and close any retained raw subscription. Disconnect MCP clients with `disconnectAllMCP()` if your application created them. For database stores, call `await store.close()` after all agents and event writers have finished. Do not dispose a shared sandbox or store while another agent uses it.

## Next steps

- [Concepts](./concepts.md)
- [Events](../guides/events.md)
- [Tools](../guides/tools.md)
- [Database](../guides/database.md)
