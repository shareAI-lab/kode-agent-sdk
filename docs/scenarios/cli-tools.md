# Scenario: CLI Agent Tools

> Build command-line AI assistants like Claude Code, Cursor, or custom developer tools.

---

## Why CLI is Perfect for KODE SDK

| Feature | Benefit |
|---------|---------|
| Single process | No distributed complexity |
| Local filesystem | JSONStore works perfectly |
| Long-running | Agent loops run naturally |
| Single user | No multi-tenancy needed |

**Compatibility: 100%** - This is KODE SDK's sweet spot.

---

## Quick Start: Minimal CLI Agent

```typescript
// cli-agent.ts
import { Agent, AnthropicProvider, LocalSandbox } from '@anthropic/kode-sdk';
import * as readline from 'readline';

async function main() {
  // Create agent with local persistence
  const agent = await Agent.create({
    agentId: 'cli-assistant',
    template: {
      systemPrompt: `You are a helpful CLI assistant.
You can execute bash commands and help with file operations.`,
    },
    deps: {
      modelProvider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY!),
      sandbox: new LocalSandbox({ workDir: process.cwd() }),
    },
  });

  // Stream output to terminal
  agent.subscribeProgress({ kinds: ['text_chunk'] }, (event) => {
    process.stdout.write(event.text);
  });

  // Show tool execution
  agent.subscribeProgress({ kinds: ['tool:start', 'tool:complete'] }, (event) => {
    if (event.kind === 'tool:start') {
      console.log(`\n[Running: ${event.name}]`);
    }
  });

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
        await agent.chat(input);
        console.log('\n');
      }
      askQuestion();
    });
  };

  askQuestion();
}

main().catch(console.error);
```

Run it:
```bash
npx ts-node cli-agent.ts
```

---

## Production CLI: Resume & Persistence

For a production CLI tool, you want:
1. **Session persistence** - Resume conversations across runs
2. **Crash recovery** - Don't lose progress
3. **Multiple sessions** - Switch between contexts

```typescript
// production-cli.ts
import { Agent, AgentPool, AnthropicProvider, LocalSandbox, JSONStore } from '@anthropic/kode-sdk';
import * as path from 'path';
import * as os from 'os';

// Store data in user's home directory
const DATA_DIR = path.join(os.homedir(), '.my-cli-agent');
const store = new JSONStore(DATA_DIR);

async function getOrCreateAgent(sessionId: string): Promise<Agent> {
  const pool = new AgentPool({ store, maxAgents: 10 });

  // Try to resume existing session
  try {
    const agent = await pool.resume(sessionId, {
      template: { systemPrompt: '...' },
    }, {
      modelProvider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY!),
      sandbox: new LocalSandbox({ workDir: process.cwd() }),
    });
    console.log(`Resumed session: ${sessionId}`);
    return agent;
  } catch {
    // Create new session
    const agent = await pool.create(sessionId, {
      template: { systemPrompt: '...' },
    }, {
      modelProvider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY!),
      sandbox: new LocalSandbox({ workDir: process.cwd() }),
    });
    console.log(`Created new session: ${sessionId}`);
    return agent;
  }
}

// Usage
const sessionId = process.argv[2] || 'default';
const agent = await getOrCreateAgent(sessionId);
```

---

## Tool Approval Flow

For dangerous operations, implement approval:

```typescript
import { PermissionMode } from '@anthropic/kode-sdk';

const agent = await Agent.create({
  agentId: 'safe-cli',
  config: {
    permission: {
      mode: 'approval',  // Require approval for all tools
      // Or custom mode:
      // mode: 'custom',
      // customMode: async (call, ctx) => {
      //   if (call.name === 'bash_run') {
      //     return { decision: 'ask' };  // Prompt user
      //   }
      //   return { decision: 'allow' };
      // }
    },
  },
  // ...
});

// Handle approval requests
agent.subscribeControl((event) => {
  if (event.kind === 'permission_required') {
    console.log(`\nTool requires approval: ${event.toolName}`);
    console.log(`Input: ${JSON.stringify(event.input, null, 2)}`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('Approve? (y/n): ', (answer) => {
      agent.approveToolUse(event.callId, answer.toLowerCase() === 'y');
      rl.close();
    });
  }
});
```

---

## Example: Developer Assistant CLI

Complete example with file operations, git commands, and safety:

```typescript
// dev-assistant.ts
import {
  Agent,
  AnthropicProvider,
  LocalSandbox,
  JSONStore,
  defineSimpleTool,
} from '@anthropic/kode-sdk';

// Custom tools
const gitStatusTool = defineSimpleTool({
  name: 'git_status',
  description: 'Check git repository status',
  parameters: {},
  execute: async () => {
    const { execSync } = await import('child_process');
    return execSync('git status --porcelain').toString();
  },
});

const searchCodeTool = defineSimpleTool({
  name: 'search_code',
  description: 'Search for patterns in code files',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (regex)' },
      fileType: { type: 'string', description: 'File extension (e.g., ts, js)' },
    },
    required: ['pattern'],
  },
  execute: async ({ pattern, fileType }) => {
    const { execSync } = await import('child_process');
    const glob = fileType ? `--include="*.${fileType}"` : '';
    return execSync(`grep -r ${glob} "${pattern}" . 2>/dev/null || echo "No matches"`).toString();
  },
});

async function main() {
  const agent = await Agent.create({
    agentId: 'dev-assistant',
    template: {
      systemPrompt: `You are a developer assistant.
You help with:
- Code navigation and search
- Git operations
- File management
- Running tests and builds

Always explain what you're doing before executing commands.
Be cautious with destructive operations.`,
      tools: [gitStatusTool, searchCodeTool],  // Add custom tools
    },
    config: {
      permission: {
        mode: 'auto',  // Auto-approve safe operations
        autoApprove: ['git_status', 'search_code', 'file_read'],
        requireApproval: ['bash_run', 'file_write', 'file_delete'],
      },
    },
    deps: {
      modelProvider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY!, 'claude-sonnet-4-20250514'),
      sandbox: new LocalSandbox({ workDir: process.cwd() }),
      store: new JSONStore('./.dev-assistant'),
    },
  });

  // ... rest of CLI implementation
}
```

---

## Best Practices for CLI Agents

### 1. Progress Indication

```typescript
// Show spinner during model calls
agent.subscribeMonitor((event) => {
  if (event.kind === 'model_start') {
    process.stdout.write('Thinking...');
  }
  if (event.kind === 'model_complete') {
    process.stdout.write('\r          \r');  // Clear spinner
  }
});
```

### 2. Graceful Shutdown

```typescript
// Handle Ctrl+C
process.on('SIGINT', async () => {
  console.log('\nSaving session...');
  await agent.persistInfo();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await agent.persistInfo();
  process.exit(0);
});
```

### 3. Token Usage Tracking

```typescript
let totalTokens = 0;

agent.subscribeMonitor((event) => {
  if (event.kind === 'token_usage') {
    totalTokens += event.inputTokens + event.outputTokens;
    // Show in status bar or on exit
  }
});

process.on('exit', () => {
  console.log(`\nTotal tokens used: ${totalTokens}`);
});
```

### 4. History Navigation

```typescript
// Show conversation history on start
const messages = await agent.getMessages();
console.log(`Session has ${messages.length} messages`);

// Allow user to see recent context
if (messages.length > 0) {
  const last = messages[messages.length - 1];
  console.log(`Last message: ${last.role}: ${last.content.slice(0, 100)}...`);
}
```

---

## File Structure

Recommended project structure for a CLI agent:

```
my-cli-agent/
├── src/
│   ├── index.ts          # Entry point
│   ├── agent.ts          # Agent configuration
│   ├── tools/            # Custom tools
│   │   ├── git.ts
│   │   ├── search.ts
│   │   └── index.ts
│   └── ui/               # Terminal UI
│       ├── spinner.ts
│       ├── prompt.ts
│       └── colors.ts
├── data/                 # Agent persistence (gitignored)
├── package.json
└── tsconfig.json
```

---

## Next Steps

- See [Tools Guide](../tools.md) for building custom tools
- See [Events Guide](../events.md) for advanced event handling
- See [Playbooks](../playbooks.md) for common patterns
