# Resume / Fork Guide

Long-running Agents must have the ability to "resume anytime, fork, and audit". KODE SDK implements a unified persistence protocol at the kernel level (messages, tool calls, Todo, events, breakpoints, lineage).

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Metadata** | Serializes template, tool descriptors, permissions, Todo, sandbox config, breakpoints, lineage |
| **Safe-Fork-Point (SFP)** | Every user message or tool result creates a recoverable node for snapshot/fork |
| **BreakpointState** | Marks current execution phase (`READY` → `PRE_MODEL` → ... → `POST_TOOL`) |
| **Auto-Seal** | When crash occurs during tool execution, Resume auto-seals with `tool_result` |

---

## Resume Methods

### Method 1: Explicit Configuration

```typescript
import { Agent } from '@shareai-lab/kode-sdk';

const agent = await Agent.resume('agt-demo', {
  templateId: 'repo-assistant',
  modelConfig: {
    provider: 'anthropic',
    model: process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-20250514',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true },
}, deps, {
  strategy: 'crash',  // Auto-seal incomplete tools
  autoRun: false,     // Rebind listeners before starting work
});
```

### Method 2: Resume from Store (Recommended)

```typescript
const agent = await Agent.resumeFromStore('agt-demo', deps, {
  overrides: {
    modelConfig: {
      provider: 'anthropic',
      model: process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-20250514',
      apiKey: process.env.ANTHROPIC_API_KEY!,
    },
  },
});
```

Resume uses stored metadata by default. Explicit `model` / `modelConfig`, sandbox, permission, Todo and context overrides take precedence. To rotate credentials or change a model, supply an override or a modelFactory that obtains current configuration. Use `autoRun: false` (the default) so you can rebind approval and monitor listeners before sending; callbacks are not persisted. Stop and finish the original agent before resuming the same ID in another instance.

LocalSandbox instances preserve boundary, allow-path and watch settings via `toConfig()`. A custom sandbox instance without `toConfig()` must be supplied again through `overrides.sandbox` when resuming; the SDK will not silently replace it with a local sandbox.

### Resume Options

| Option | Values | Description |
|--------|--------|-------------|
| `strategy` | `'manual'` \| `'crash'` | `crash` auto-seals incomplete tools |
| `autoRun` | `boolean` | Continue processing message queue after resume |
| `overrides` | `Partial<AgentConfig>` | Override metadata (model upgrade, permission changes, etc.) |

> **Important**: You **must** re-bind event listeners after Resume (Control/Monitor callbacks are not auto-restored).

---

## SDK vs Application Responsibilities

| Capability | SDK | Application |
|------------|-----|-------------|
| Template, tools, sandbox restore | Auto-rebuild | Not needed |
| Messages, tool records, Todo, Lineage | Auto-load | Not needed |
| FilePool watching | Auto-restore | Not needed |
| Hooks | Auto-register | Not needed |
| Control/Monitor listeners | Not handled | Must re-bind after Resume |
| Approval flows, alerts | Not handled | Integrate with business systems |
| Dependency singleton management | Not handled | Ensure `store`/`registry` global reuse |

---

## Snapshot and Fork

### Creating Snapshots

```typescript
// Create snapshot at current point
const bookmarkId = await agent.snapshot('pre-release-audit');
```

### Forking an Agent

```typescript
// Fork from a snapshot
const forked = await agent.fork(bookmarkId);

// Fork from latest point
const forked2 = await agent.fork();

// Use forked Agent
await forked.send('This is a new task forked from the original conversation.');
```

- `snapshot(label?)` returns `SnapshotId` (default: `sfp-{index}`)
- `fork(sel?)` creates new Agent: inherits tools/permissions/lineage, copies messages to new Store namespace
- Forked Agent needs independent event binding

---

## Auto-Seal Mechanism

When crash occurs during these phases, Resume auto-writes compensating `tool_result`:

| Phase | Seal Info | Recommended Action |
|-------|-----------|-------------------|
| `PENDING` | Tool not executed | Validate params and retry |
| `APPROVAL_REQUIRED` | Waiting for approval | Re-trigger approval or manually complete |
| `APPROVED` | Ready to execute | Confirm input still valid and retry |
| `EXECUTING` | Execution interrupted | Check side effects, manual confirm if needed |

Auto-seal triggers:

- `monitor.agent_resumed`: Contains `sealed` list and `strategy`
- `progress.tool:end`: Adds failed `tool_result` with `recommendations`

---

## Re-binding Events After Resume

```typescript
const agent = await Agent.resumeFromStore('agt-demo', deps);

// Re-bind Control/Monitor event listeners
agent.on('tool_executed', (event) => {
  console.log('Tool executed:', event.call.name);
});

agent.on('error', (event) => {
  console.error('Error:', event.message);
});

agent.on('permission_required', async (event) => {
  await event.respond('allow');
});

// For Progress events, use subscribe()
const progressSubscription = (async () => {
  for await (const envelope of agent.subscribe(['progress'])) {
    if (envelope.event.type === 'text_chunk') {
      process.stdout.write(envelope.event.delta);
    }
    if (envelope.event.type === 'done') break;
  }
})();

// Continue processing
await agent.run();
await progressSubscription;
```

---

## Multi-Instance / Serverless Best Practices

1. **Singleton Dependencies**: Create `AgentDependencies` at module level to avoid multiple instances writing to same Store directory

2. **Event Re-binding**: Call event binding immediately after every `resume`

3. **Concurrency Control**: Same AgentId should only run in single instance; use external locks or queues

4. **Persistence Directory**: `JSONStore` works for single-machine or shared disk environments. For distributed deployments, implement custom Store (e.g., S3 + DynamoDB)

5. **Observability**: Listen to `monitor.state_changed` and `monitor.error` for quick issue identification

---

## Troubleshooting

| Symptom | Investigation |
|---------|--------------|
| `AGENT_NOT_FOUND` on Resume | Store directory missing or not persisted. Check `store.baseDir` mount |
| `TEMPLATE_NOT_FOUND` on Resume | Template not registered at startup; ensure template ID matches metadata |
| Missing tools | ToolRegistry not registered; built-in tools need manual registration |
| FilePool not restored | Custom Sandbox not implementing `watchFiles`; disable watch or complete implementation |
| Event listeners not working | Not calling `agent.on(...)` after Resume |

---

## Resume one turn with application-owned dependencies

Register the original template/tools and modelFactory in deps, and keep its persistent store open. This helper receives those dependencies explicitly, creates and disposes its own sandbox, defaults pending tool requests to denial, and returns the next reply. The caller owns closing the store after all agents finish.

<!-- runnable:resume-helper -->
```typescript
import { Agent, AgentDependencies, LocalSandbox } from '@shareai-lab/kode-sdk';

export async function resumeOneTurn(
  agentId: string,
  deps: AgentDependencies,
  workDir: string,
  input: string
): Promise<string> {
  const sandbox = new LocalSandbox({ workDir, enforceBoundary: true, watchFiles: false });
  const unsubscribe: Array<() => void> = [];
  let agent: Agent | undefined;
  try {
    agent = await Agent.resumeFromStore(agentId, deps, {
      strategy: 'crash', autoRun: false, overrides: { sandbox },
    });
    unsubscribe.push(agent.on('permission_required', event => {
      void event.respond('deny', { note: 'No interactive approval handler configured' });
    }));
    unsubscribe.push(agent.on('error', event => console.error(event.message)));
    let reply = '';
    for await (const { event } of agent.chatStream(input)) {
      if (event.type === 'text_chunk') {
        process.stdout.write(event.delta);
        reply += event.delta;
      }
    }
    return reply;
  } finally {
    unsubscribe.forEach(off => off());
    agent?.schedule().clear();
    await sandbox.dispose();
  }
}
```

---

## References

- [Events Guide](./events.md)
- [Error Handling Guide](./error-handling.md)
- [Database Guide](./database.md)
