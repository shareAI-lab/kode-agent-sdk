# Scenario: Desktop Applications

> Build Electron/Tauri apps with embedded AI agents.

---

## Why Desktop is Perfect for KODE SDK

| Feature | Benefit |
|---------|---------|
| Full filesystem access | JSONStore works natively |
| Long-running process | Agent loops run without timeout |
| Local resources | No network latency for persistence |
| Single user | No multi-tenancy complexity |

**Compatibility: 95%** - Minor adjustments for IPC.

---

## Electron Integration

### Main Process Setup

```typescript
// main/agent-service.ts
import { Agent, AgentPool, AnthropicProvider, LocalSandbox, JSONStore } from '@anthropic/kode-sdk';
import { app, ipcMain } from 'electron';
import * as path from 'path';

// Store data in app's user data directory
const DATA_DIR = path.join(app.getPath('userData'), 'agents');
const store = new JSONStore(DATA_DIR);
const pool = new AgentPool({ store, maxAgents: 20 });

// Create agent
ipcMain.handle('agent:create', async (event, { agentId, systemPrompt }) => {
  const agent = await pool.create(agentId, {
    template: { systemPrompt },
  }, {
    modelProvider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY!),
    sandbox: new LocalSandbox({ workDir: app.getPath('documents') }),
  });

  // Forward events to renderer
  agent.subscribeProgress({ kinds: ['text_chunk', 'tool:start', 'tool:complete', 'done'] }, (event) => {
    event.sender.send(`agent:progress:${agentId}`, event);
  });

  return { success: true, agentId };
});

// Send message
ipcMain.handle('agent:chat', async (event, { agentId, message }) => {
  const agent = pool.get(agentId);
  if (!agent) throw new Error('Agent not found');

  await agent.chat(message);
  return { success: true };
});

// List agents
ipcMain.handle('agent:list', async () => {
  const agents = await store.listAgents();
  return agents;
});

// Graceful shutdown
app.on('before-quit', async (event) => {
  event.preventDefault();
  for (const [id, agent] of pool.agents) {
    await agent.persistInfo();
  }
  app.quit();
});
```

### Renderer Process (React)

```typescript
// renderer/hooks/useAgent.ts
import { useState, useEffect, useCallback } from 'react';

export function useAgent(agentId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    // Listen for progress events
    const handler = (event: any, data: ProgressEvent) => {
      if (data.kind === 'text_chunk') {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant') {
            return [...prev.slice(0, -1), {
              ...last,
              content: last.content + data.text,
            }];
          }
          return [...prev, { role: 'assistant', content: data.text }];
        });
      }
      if (data.kind === 'done') {
        setIsProcessing(false);
      }
    };

    window.electron.on(`agent:progress:${agentId}`, handler);
    return () => window.electron.off(`agent:progress:${agentId}`, handler);
  }, [agentId]);

  const sendMessage = useCallback(async (text: string) => {
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setIsProcessing(true);
    await window.electron.invoke('agent:chat', { agentId, message: text });
  }, [agentId]);

  return { messages, isProcessing, sendMessage };
}
```

---

## Tauri Integration

```rust
// src-tauri/src/main.rs
use tauri::Manager;

#[tauri::command]
async fn create_agent(app: tauri::AppHandle, agent_id: String) -> Result<(), String> {
    // Use sidecar process for Node.js agent runtime
    let sidecar = app.shell()
        .sidecar("agent-runtime")
        .expect("failed to create sidecar");

    sidecar.spawn().expect("failed to spawn sidecar");
    Ok(())
}
```

```typescript
// agent-runtime/index.ts (sidecar)
// Same KODE SDK code as Electron main process
// Communicate via Tauri's shell commands
```

---

## Best Practices

### 1. Data Directory

```typescript
// Cross-platform data directory
import { app } from 'electron';

const getDataDir = () => {
  // macOS: ~/Library/Application Support/YourApp/agents
  // Windows: %APPDATA%/YourApp/agents
  // Linux: ~/.config/YourApp/agents
  return path.join(app.getPath('userData'), 'agents');
};
```

### 2. Workspace Integration

```typescript
// Let user choose workspace
const workspace = await dialog.showOpenDialog({
  properties: ['openDirectory'],
  title: 'Select Agent Workspace',
});

const sandbox = new LocalSandbox({
  workDir: workspace.filePaths[0],
  allowedPaths: [workspace.filePaths[0]],  // Restrict to selected folder
});
```

### 3. Auto-update Agents

```typescript
// On app update, migrate agent data if needed
app.on('ready', async () => {
  const version = app.getVersion();
  const lastVersion = store.get('lastVersion');

  if (lastVersion !== version) {
    await migrateAgentData(lastVersion, version);
    store.set('lastVersion', version);
  }
});
```

---

## Example: AI Writing Assistant

```typescript
// Complete desktop writing assistant
const writingAssistant = await Agent.create({
  agentId: 'writing-assistant',
  template: {
    systemPrompt: `You are a writing assistant embedded in a desktop app.
You help users write, edit, and improve their documents.
You can read and write files in the user's workspace.`,
    tools: [
      // Custom tool to interact with the editor
      defineSimpleTool({
        name: 'insert_text',
        description: 'Insert text at cursor position in the editor',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            position: { type: 'number' },
          },
          required: ['text'],
        },
        execute: async ({ text, position }) => {
          // Send to renderer via IPC
          mainWindow.webContents.send('editor:insert', { text, position });
          return 'Text inserted';
        },
      }),
    ],
  },
  // ...
});
```

---

See [CLI Tools Guide](./cli-tools.md) for more patterns that apply to desktop apps.
