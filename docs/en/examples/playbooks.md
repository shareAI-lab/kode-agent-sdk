# Playbooks: Common Scenario Scripts

This page breaks down the most common usage scenarios from a practical perspective, providing mental maps, key APIs, example files, and considerations. Example code is in the `examples/` directory and can be run directly with `ts-node`.

---

## 1. Collaborative Inbox (Event-Driven UI)

- **Goal**: Persistent single Agent, UI displays text/tool progress via Progress stream, Monitor for lightweight alerts.
- **Example**: `examples/01-agent-inbox.ts`
- **Run**: `npm run example:agent-inbox`
- **Key Steps**:
  1. `Agent.create` + `agent.subscribe(['progress'])` pushes text increments.
  2. Use `bookmark` / `cursor` for checkpoint replay.
  3. `agent.on('tool_executed')` / `agent.on('error')` writes governance events to logs or monitoring.
  4. `agent.todoManager` for auto-reminders, UI can display Todo panel.
- **Considerations**:
  - Expose Progress stream to frontend via SSE/WebSocket.
  - Enable `exposeThinking` in template metadata if UI needs thinking process.

```typescript
// Basic event subscription
for await (const envelope of agent.subscribe(['progress'])) {
  if (envelope.event.type === 'text_chunk') {
    process.stdout.write(envelope.event.delta);
  }
  if (envelope.event.type === 'done') {
    break;
  }
}
```

---

## 2. Tool Approval & Governance

- **Goal**: Approval for sensitive tools (e.g., `bash_run`, database writes); combine with Hooks for policy guards.
- **Example**: `examples/02-approval-control.ts`
- **Run**: `npm run example:approval`
- **Key Steps**:
  1. Configure `permission` in template (e.g., `mode: 'approval'` + `requireApprovalTools`).
  2. Subscribe to `agent.on('permission_required')`, push approval tasks to business system.
  3. Approval UI calls `agent.decide(id, 'allow' | 'deny', note)`.
  4. Combine with `HookManager`'s `preToolUse` / `postToolUse` for finer-grained policies (path guards, result truncation).
- **Considerations**:
  - Agent is at `AWAITING_APPROVAL` breakpoint during approval; SDK auto-resumes after decision.
  - Denying a tool automatically writes `tool_result`, UI can prompt retry strategies.

```typescript
// Permission configuration
const template = {
  id: 'secure-runner',
  permission: {
    mode: 'approval',
    requireApprovalTools: ['bash_run'],
  },
  // Hook for additional guards
  hooks: {
    preToolUse(call) {
      if (call.name === 'bash_run' && /rm -rf|sudo/.test(call.args.cmd)) {
        return { decision: 'deny', reason: 'Command matches forbidden keywords' };
      }
    },
  },
};

// Approval handling
agent.on('permission_required', async (event) => {
  const decision = await getApprovalFromAdmin(event.call);
  await event.respond(decision, { note: 'Approved by admin' });
});
```

---

## 3. Multi-Agent Team Collaboration

- **Goal**: One Planner coordinates multiple Specialists, all Agents persistent and forkable.
- **Example**: `examples/03-room-collab.ts`
- **Run**: `npm run example:room`
- **Key Steps**:
  1. Use singleton `AgentPool` to manage Agent lifecycle (`create` / `resume` / `fork`).
  2. Use `Room` for broadcast/mention messages; messages use `[from:name]` pattern for collaboration.
  3. Sub-Agents launched via `task_run` tool or explicit `pool.create`.
  4. Use `agent.snapshot()` + `agent.fork()` to fork at Safe-Fork-Points.
- **Considerations**:
  - Template's `runtime.subagents` can limit dispatchable templates and depth.
  - Persist lineage (SDK writes to metadata by default) for audit and replay.
  - Disable `watchFiles` in template if not monitoring external files.

```typescript
const pool = new AgentPool({ dependencies: deps, maxAgents: 10 });
const room = new Room(pool);

const planner = await pool.create('agt-planner', { templateId: 'planner', ... });
const dev = await pool.create('agt-dev', { templateId: 'executor', ... });

room.join('planner', planner.agentId);
room.join('dev', dev.agentId);

// Broadcast to room
await room.say('planner', 'Hi team, let us audit the repository. @dev please execute.');
await room.say('dev', 'Acknowledged, working on it.');
```

---

## 4. Scheduling & System Reminders

- **Goal**: Agent executes periodic tasks, monitors file changes, sends system reminders during long-running operations.
- **Example**: `examples/04-scheduler-watch.ts`
- **Run**: `npm run example:scheduler`
- **Key Steps**:
  1. `const scheduler = agent.schedule(); scheduler.everySteps(N, callback)` registers step triggers.
  2. Use `agent.remind(text, options)` for system-level reminders (via Monitor, doesn't pollute Progress).
  3. FilePool monitors written files by default, combine `monitor.file_changed` with `scheduler.notifyExternalTrigger` for auto-response.
  4. Todo with `remindIntervalSteps` for periodic reviews.
- **Considerations**:
  - Keep scheduled tasks idempotent, follow event-driven principles.
  - For high-frequency tasks, combine with external Cron and call `scheduler.notifyExternalTrigger`.

---

## 5. Database Persistence

- **Goal**: Persist Agent state to SQLite or PostgreSQL for production deployments.
- **Example**: `examples/db-sqlite.ts`, `examples/db-postgres.ts`
- **Key Steps**:
  1. Use `createExtendedStore` factory function to create store.
  2. Pass store to Agent dependencies.
  3. Use Query APIs for session management and analytics.

```typescript
import { createExtendedStore, SqliteStore } from '@shareai-lab/kode-sdk';

// Create SQLite store
const store = createExtendedStore({
  type: 'sqlite',
  dbPath: './data/agents.db',
  fileStoreBaseDir: './data/files',
}) as SqliteStore;

// Use with Agent
const agent = await Agent.create(
  { templateId: 'my-agent', ... },
  { store, ... }
);

// Query APIs
const sessions = await store.querySessions({ limit: 10 });
const stats = await store.aggregateStats(agent.agentId);
```

---

## 6. Observability Readers + Application HTTP Wrapper

- **Goal**: Read runtime/persisted observations from the SDK and optionally expose them through your own app-layer HTTP service.
- **Example**: `examples/08-observability-http.ts`
- **Run**: `npm run example:observability-http`
- **Key Steps**:
  1. Read point-in-time metrics with `agent.getMetricsSnapshot()`.
  2. Read live in-memory observations with `agent.getObservationReader()` or `agent.subscribeObservations()`.
  3. Configure `observability.persistence.backend` and query history with `createStoreBackedObservationReader(...)`.
  4. Map your own routes, auth, tenant checks, and response shaping in application code.
- **Considerations**:
  - Prefer runtime reader for "what is happening now" and persisted reader for audit/history views.
  - Treat `metadata.__debug` as internal/debug-only data; do not expose it blindly to external consumers.
  - Keep HTTP, auth, rate limiting, and dashboard concerns outside SDK core.

```typescript
const metrics = agent.getMetricsSnapshot();
const runtimeReader = agent.getObservationReader();
const persistedReader = createStoreBackedObservationReader(observationBackend);

const runtime = runtimeReader.listObservations({ limit: 20 });
const persisted = await persistedReader.listObservations({ agentIds: [agent.agentId], limit: 50 });
```

---

## 7. Combined: Approval + Collaboration + Scheduling

- **Scenario**: Code review bot, Planner splits tasks and assigns to Specialists, tool operations need approval, scheduled reminders ensure SLA.
- **Implementation**:
  1. **Planner template**: Has `task_run` tool and scheduling hooks, auto-patrol each morning.
  2. **Specialist template**: Focuses on `fs_*` + `todo_*` tools, approval only for `bash_run`.
  3. **Unified approval service**: Listens to all Agent Control events, integrates with enterprise IM/approval workflow.
  4. **Room collaboration**: Planner delivers tasks via `@executor`, executor reports back via `@planner`.
  5. **SLA monitoring**: Monitor events feed into observability pipeline (Prometheus/ELK/Datadog).
  6. **Scheduled reminders**: Use Scheduler to periodically check todos or external system signals.

---

## Quick API Reference

| Category | API |
|----------|-----|
| Events | `agent.subscribe(['progress'])`, `agent.on('error', handler)`, `agent.on('tool_executed', handler)` |
| Approval | `permission_required` → `event.respond()` / `agent.decide()` |
| Multi-Agent | `new AgentPool({ dependencies, maxAgents })`, `const room = new Room(pool)` |
| Fork | `const snapshot = await agent.snapshot(); const fork = await agent.fork(snapshot);` |
| Scheduling | `agent.schedule().everySteps(10, ...)`, `scheduler.notifyExternalTrigger(...)` |
| Todo | `agent.getTodos()` / `agent.setTodos()` / `todo_read` / `todo_write` |
| Database | `createExtendedStore({ type: 'sqlite', ... })`, `store.querySessions()` |

---

## References

- [Getting Started](../getting-started/quickstart.md)
- [Events Guide](../guides/events.md)
- [Observability Guide](../guides/observability.md)
- [Multi-Agent Systems](../advanced/multi-agent.md)
- [Database Guide](../guides/database.md)

---

## 8. CLI Agent Application

Build command-line AI assistants like Claude Code or Cursor.

### Minimal CLI Agent

```typescript
// cli-agent.ts
import { Agent, AnthropicProvider, JSONStore, LocalSandbox } from '@shareai-lab/kode-sdk';
import * as readline from 'readline';

async function main() {
  const store = new JSONStore('./.cli-agent');
  const provider = new AnthropicProvider(process.env.ANTHROPIC_API_KEY!);
  const sandbox = new LocalSandbox({ workDir: process.cwd() });

  const agent = await Agent.create({
    templateId: 'cli-assistant',
    model: provider,
    sandbox: { kind: 'local', workDir: process.cwd() },
  }, {
    store,
    templateRegistry,
    sandboxFactory,
    toolRegistry,
  });

  // Stream output to terminal using subscribe
  (async () => {
    for await (const envelope of agent.subscribe(['progress'])) {
      if (envelope.event.type === 'text_chunk') {
        process.stdout.write(envelope.event.delta);
      }
      if (envelope.event.type === 'tool:start') {
        console.log(`\n[Running: ${envelope.event.call.name}]`);
      }
      if (envelope.event.type === 'done') {
        break;
      }
    }
  })();

  // Interactive loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('CLI Agent ready. Type your message (Ctrl+C to exit)\n');

  const askQuestion = () => {
    rl.question('You: ', async (input) => {
      if (input.trim()) {
        console.log('\nAssistant: ');
        await agent.complete(input);  // complete() handles send + wait
        console.log('\n');
      }
      askQuestion();
    });
  };

  askQuestion();
}

main().catch(console.error);
```

### Production CLI with Session Management

```typescript
// production-cli.ts
import { Agent, AgentPool, JSONStore } from '@shareai-lab/kode-sdk';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { program } from 'commander';

const DATA_DIR = path.join(os.homedir(), '.my-cli-agent');
const store = new JSONStore(DATA_DIR);

async function createDependencies() {
  return {
    store,
    templateRegistry: /* ... */,
    sandboxFactory: /* ... */,
    toolRegistry: /* ... */,
  };
}

async function main() {
  program
    .option('-s, --session <id>', 'Session ID to resume', 'default')
    .option('-n, --new', 'Start new session (ignore existing)')
    .option('-l, --list', 'List all sessions')
    .parse();

  const opts = program.opts();
  const deps = await createDependencies();

  // List sessions
  if (opts.list) {
    const sessions = await store.list();
    console.log('Available sessions:');
    sessions.forEach(s => console.log(`  - ${s}`));
    return;
  }

  const pool = new AgentPool({ dependencies: deps, maxAgents: 5 });
  const sessionId = opts.session;

  // Resume or create agent
  let agent: Agent;
  const exists = await store.exists(sessionId);

  if (exists && !opts.new) {
    console.log(`Resuming session: ${sessionId}`);
    agent = await pool.resume(sessionId, { templateId: 'cli-assistant' });
  } else {
    console.log(`Starting new session: ${sessionId}`);
    agent = await pool.create(sessionId, { templateId: 'cli-assistant' });
  }

  // Event handlers
  for await (const envelope of agent.subscribe(['progress'])) {
    switch (envelope.event.type) {
      case 'text_chunk':
        process.stdout.write(envelope.event.delta);
        break;
      case 'tool:start':
        console.log(`\n[Tool: ${envelope.event.call.name}]`);
        break;
      case 'done':
        console.log('\n');
        break;
    }
  }

  // Interactive loop with special commands
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const processInput = async (input: string) => {
    const trimmed = input.trim();

    // Special commands
    if (trimmed === '/exit' || trimmed === '/quit') {
      console.log('Goodbye!');
      process.exit(0);
    }
    if (trimmed === '/clear') {
      // Fork to create fresh context
      const snapshot = await agent.snapshot('clear-point');
      agent = await agent.fork(snapshot);  // snapshot is already a SnapshotId
      console.log('Context cleared.');
      return;
    }
    if (trimmed === '/status') {
      const status = agent.status();
      console.log(`Session: ${status.agentId}`);
      console.log(`Steps: ${status.stepCount}`);
      console.log(`State: ${status.state}`);
      return;
    }

    // Normal message
    if (trimmed) {
      console.log('\nAssistant: ');
      await agent.complete(trimmed);
    }
  };

  console.log('Ready. Commands: /exit, /clear, /status\n');

  rl.on('line', async (line) => {
    await processInput(line);
    rl.prompt();
  });

  rl.prompt();
}

main().catch(console.error);
```

---

## 8. Desktop App (Electron)

Build desktop AI applications with Electron or Tauri.

### Architecture Overview

```
┌────────────────────────────────────────────┐
│              Electron App                  │
│  ┌──────────────────────────────────────┐  │
│  │           Renderer Process           │  │
│  │  ┌──────────────────────────────┐    │  │
│  │  │         React UI             │    │  │
│  │  │  - Chat interface            │    │  │
│  │  │  - Tool output display       │    │  │
│  │  │  - Settings panel            │    │  │
│  │  └──────────────┬───────────────┘    │  │
│  └─────────────────┼────────────────────┘  │
│                    │ IPC                    │
│  ┌─────────────────▼────────────────────┐  │
│  │            Main Process              │  │
│  │  ┌──────────────────────────────┐    │  │
│  │  │         AgentPool            │    │  │
│  │  │  - Agent lifecycle           │    │  │
│  │  │  - Event distribution        │    │  │
│  │  │  - Store management          │    │  │
│  │  └──────────────────────────────┘    │  │
│  │  ┌──────────────────────────────┐    │  │
│  │  │         JSONStore            │    │  │
│  │  └──────────────┬───────────────┘    │  │
│  └─────────────────┼────────────────────┘  │
└────────────────────┼────────────────────────┘
                     │
              ┌──────▼──────┐
              │  userData   │
              │   folder    │
              └─────────────┘
```

### Main Process Setup

```typescript
// main.ts
import { app, ipcMain, BrowserWindow } from 'electron';
import { AgentPool, JSONStore, Agent } from '@shareai-lab/kode-sdk';
import * as path from 'path';

let mainWindow: BrowserWindow;
let pool: AgentPool;
let store: JSONStore;

async function initializeAgent() {
  store = new JSONStore(path.join(app.getPath('userData'), 'agents'));

  pool = new AgentPool({
    dependencies: {
      store,
      templateRegistry: /* ... */,
      sandboxFactory: /* ... */,
      toolRegistry: /* ... */,
    },
    maxAgents: 10,
  });
}

// IPC: Send message to agent
ipcMain.handle('agent:send', async (event, { agentId, message }) => {
  let agent = pool.get(agentId);

  if (!agent) {
    const exists = await store.exists(agentId);
    agent = exists
      ? await pool.resume(agentId, { templateId: 'desktop-assistant' })
      : await pool.create(agentId, { templateId: 'desktop-assistant' });
  }

  return agent.complete(message);  // complete() handles send + wait
});

// IPC: Subscribe to events (streaming)
ipcMain.on('agent:subscribe', (event, { agentId }) => {
  const agent = pool.get(agentId);
  if (!agent) return;

  // Stream events to renderer
  (async () => {
    for await (const env of agent.subscribe(['progress'])) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(`agent:event:${agentId}`, env.event);
      }
      if (env.event.type === 'done') break;
    }
  })();
});

// IPC: Create new agent
ipcMain.handle('agent:create', async (event, { agentId, templateId }) => {
  const agent = await pool.create(agentId, { templateId });
  return { agentId: agent.agentId, status: 'created' };
});

// IPC: List agents
ipcMain.handle('agent:list', async () => {
  return store.list();
});

// IPC: Delete agent
ipcMain.handle('agent:delete', async (event, { agentId }) => {
  await pool.delete(agentId);  // pool.delete also removes from store
  return { success: true };
});

// IPC: Handle permission requests
ipcMain.on('agent:permission-subscribe', (event, { agentId }) => {
  const agent = pool.get(agentId);
  if (!agent) return;

  agent.on('permission_required', async (permEvent) => {
    mainWindow.webContents.send(`agent:permission:${agentId}`, {
      callId: permEvent.call.id,
      toolName: permEvent.call.name,
      input: permEvent.call.inputPreview,
    });
  });
});

ipcMain.handle('agent:permission-respond', async (event, { agentId, callId, decision, note }) => {
  const agent = pool.get(agentId);
  if (!agent) return { error: 'Agent not found' };

  await agent.decide(callId, decision, note);
  return { success: true };
});

app.whenReady().then(async () => {
  await initializeAgent();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  mainWindow.loadFile('index.html');
});

// Graceful shutdown
app.on('before-quit', async () => {
  for (const agentId of pool.list()) {
    const agent = pool.get(agentId);
    if (agent) await agent.interrupt();
  }
});
```

### Preload Script

```typescript
// preload.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agent', {
  send: (agentId: string, message: string) =>
    ipcRenderer.invoke('agent:send', { agentId, message }),

  create: (agentId: string, templateId: string) =>
    ipcRenderer.invoke('agent:create', { agentId, templateId }),

  list: () => ipcRenderer.invoke('agent:list'),

  delete: (agentId: string) =>
    ipcRenderer.invoke('agent:delete', { agentId }),

  subscribe: (agentId: string, callback: (event: any) => void) => {
    ipcRenderer.send('agent:subscribe', { agentId });
    ipcRenderer.on(`agent:event:${agentId}`, (_, event) => callback(event));
  },

  subscribePermission: (agentId: string, callback: (req: any) => void) => {
    ipcRenderer.send('agent:permission-subscribe', { agentId });
    ipcRenderer.on(`agent:permission:${agentId}`, (_, req) => callback(req));
  },

  respondPermission: (agentId: string, callId: string, decision: 'allow' | 'deny', note?: string) =>
    ipcRenderer.invoke('agent:permission-respond', { agentId, callId, decision, note }),
});
```

### Renderer (React)

```tsx
// App.tsx
import React, { useState, useEffect, useRef } from 'react';

declare global {
  interface Window {
    agent: {
      send: (agentId: string, message: string) => Promise<any>;
      create: (agentId: string, templateId: string) => Promise<any>;
      list: () => Promise<string[]>;
      subscribe: (agentId: string, callback: (event: any) => void) => void;
      subscribePermission: (agentId: string, callback: (req: any) => void) => void;
      respondPermission: (agentId: string, callId: string, decision: 'allow' | 'deny', note?: string) => Promise<any>;
    };
  }
}

function App() {
  const [agentId] = useState('main-agent');
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const [pendingApproval, setPendingApproval] = useState<any>(null);

  useEffect(() => {
    // Subscribe to agent events
    window.agent.subscribe(agentId, (event) => {
      switch (event.type) {
        case 'text_chunk':
          setStreaming(prev => prev + event.delta);
          break;
        case 'done':
          setMessages(prev => [...prev, { role: 'assistant', content: streaming }]);
          setStreaming('');
          break;
      }
    });

    // Subscribe to permission requests
    window.agent.subscribePermission(agentId, (req) => {
      setPendingApproval(req);
    });
  }, [agentId]);

  const handleSend = async () => {
    if (!input.trim()) return;

    setMessages(prev => [...prev, { role: 'user', content: input }]);
    setInput('');

    await window.agent.send(agentId, input);
  };

  const handleApproval = async (decision: 'allow' | 'deny') => {
    if (!pendingApproval) return;
    await window.agent.respondPermission(agentId, pendingApproval.callId, decision);
    setPendingApproval(null);
  };

  return (
    <div className="app">
      <div className="messages">
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {streaming && <div className="message assistant streaming">{streaming}</div>}
      </div>

      {pendingApproval && (
        <div className="approval-dialog">
          <p>Tool requires approval: {pendingApproval.toolName}</p>
          <pre>{JSON.stringify(pendingApproval.input, null, 2)}</pre>
          <button onClick={() => handleApproval('allow')}>Allow</button>
          <button onClick={() => handleApproval('deny')}>Deny</button>
        </div>
      )}

      <div className="input-area">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Type a message..."
        />
        <button onClick={handleSend}>Send</button>
      </div>
    </div>
  );
}

export default App;
```

### Best Practices for Desktop Apps

1. **Run KODE SDK in Main Process** - Renderer should only handle UI
2. **Use IPC for Communication** - Never expose Node.js APIs directly to renderer
3. **Graceful Shutdown** - Interrupt agents before app quit
4. **Store in userData** - Use `app.getPath('userData')` for persistence
5. **Stream Events** - Don't batch events, stream them for responsive UI
6. **Handle Permissions** - Show approval dialogs for sensitive tools

---

*See also: [Production Deployment](../advanced/production.md) | [Architecture Guide](../advanced/architecture.md)*
