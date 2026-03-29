# Multi-Agent Systems

This guide covers building multi-Agent systems using KODE SDK's coordination primitives: AgentPool, Room, and task_run.

---

## Overview

| Component | Use Case |
|-----------|----------|
| `AgentPool` | Manage multiple Agent instances with shared dependencies |
| `Room` | Coordinate communication between Agents with @mentions |
| `task_run` | Delegate sub-tasks to specialized Agents |

---

## AgentPool

Manages multiple Agent instances with lifecycle operations.

### Basic Usage

```typescript
import { AgentPool } from '@shareai-lab/kode-sdk';

const pool = new AgentPool({
  dependencies: deps,
  maxAgents: 50,  // Default: 50
});

// Create agents
const agent1 = await pool.create('agent-1', {
  templateId: 'researcher',
  modelConfig: { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! },
});

const agent2 = await pool.create('agent-2', {
  templateId: 'coder',
  modelConfig: { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! },
});

// Get agent by ID
const agent = pool.get('agent-1');

// List all agents
const agentIds = pool.list(); // ['agent-1', 'agent-2']

// List with prefix filter
const researchers = pool.list({ prefix: 'researcher-' });
```

### AgentPool API

```typescript
class AgentPool {
  constructor(opts: AgentPoolOptions);

  // Create new agent
  async create(agentId: string, config: AgentConfig): Promise<Agent>;

  // Get existing agent
  get(agentId: string): Agent | undefined;

  // List agent IDs
  list(opts?: { prefix?: string }): string[];

  // Get agent status
  async status(agentId: string): Promise<AgentStatus | undefined>;

  // Fork an agent
  async fork(agentId: string, snapshotSel?: SnapshotId | { at?: string }): Promise<Agent>;

  // Resume from storage
  async resume(agentId: string, config: AgentConfig, opts?: {
    autoRun?: boolean;
    strategy?: 'crash' | 'manual';
  }): Promise<Agent>;

  // Delete an agent
  async delete(agentId: string): Promise<void>;
}
```

---

## Room

Coordinates communication between Agents with broadcast and directed messages.

### Basic Usage

```typescript
import { AgentPool, Room } from '@shareai-lab/kode-sdk';

const pool = new AgentPool({ dependencies: deps });
const room = new Room(pool);

// Create and join agents
const alice = await pool.create('alice', config);
const bob = await pool.create('bob', config);
const charlie = await pool.create('charlie', config);

room.join('Alice', 'alice');
room.join('Bob', 'bob');
room.join('Charlie', 'charlie');

// Broadcast to all (except sender)
await room.say('Alice', 'Hello everyone!');
// Bob and Charlie receive: "[from:Alice] Hello everyone!"

// Directed message with @mention
await room.say('Alice', '@Bob What do you think about this?');
// Only Bob receives: "[from:Alice] @Bob What do you think about this?"

// Multiple mentions
await room.say('Alice', '@Bob @Charlie Please review.');
// Bob and Charlie both receive the message

// Leave room
room.leave('Charlie');

// Get current members
const members = room.getMembers();
// [{ name: 'Alice', agentId: 'alice' }, { name: 'Bob', agentId: 'bob' }]
```

### Room API

```typescript
class Room {
  constructor(pool: AgentPool);

  // Join room
  join(name: string, agentId: string): void;

  // Leave room
  leave(name: string): void;

  // Send message (broadcast or directed)
  async say(from: string, text: string): Promise<void>;

  // Get members
  getMembers(): RoomMember[];
}

interface RoomMember {
  name: string;
  agentId: string;
}
```

---

## task_run Tool

Delegates tasks to specialized sub-Agents.

### Setup

```typescript
import { createTaskRunTool, AgentTemplate } from '@shareai-lab/kode-sdk';

// Define available templates
const templates: AgentTemplate[] = [
  {
    id: 'researcher',
    whenToUse: 'Research and gather information',
    tools: ['fs_read', 'fs_glob', 'fs_grep'],
  },
  {
    id: 'coder',
    whenToUse: 'Write and modify code',
    tools: ['fs_read', 'fs_write', 'fs_edit', 'bash_run'],
  },
  {
    id: 'reviewer',
    whenToUse: 'Review code and provide feedback',
    tools: ['fs_read', 'fs_glob', 'fs_grep'],
  },
];

// Create task_run tool
const taskRunTool = createTaskRunTool(templates);

// Register
deps.toolRegistry.register('task_run', () => taskRunTool);
```

### How task_run Works

When an Agent calls `task_run`:

1. Agent specifies `agentTemplateId`, `prompt`, optional `context`, and optional `model`
2. SDK creates a sub-Agent with the specified template
3. Sub-Agent processes the task
4. Result returns to parent Agent

**Tool Parameters:**

```typescript
interface TaskRunParams {
  description: string;      // Short task description (3-5 words)
  prompt: string;           // Detailed instructions
  agentTemplateId: string;  // Template ID to use
  context?: string;         // Additional context
  model?: string | { provider: string; model: string }; // Optional model override
}
```

**Tool Result:**

```typescript
interface TaskRunResult {
  status: 'ok' | 'paused';
  template: string;
  text?: string;
  permissionIds?: string[];
}
```

**Model Inheritance Notes (`delegateTask`):**
- `task_run` accepts an optional `model` argument; when omitted, delegated sub-Agents reuse the parent Agent's `ModelProvider` instance.
- If you need explicit model control, call `agent.delegateTask(...)` directly:
  - omit `model`: inherit parent model instance
  - `model: string`: keep parent provider type, override model ID (custom providers require `modelFactory`)
  - `model: { provider, model }`: explicitly choose provider + model (custom providers usually require `modelFactory` when provider differs)
  - `model: ModelProvider`: use provided provider instance directly

### Sub-Agent Configuration

Configure sub-agent behavior in template:

```typescript
const template: AgentTemplateDefinition = {
  id: 'coordinator',
  systemPrompt: 'You coordinate tasks between specialists...',
  tools: ['task_run', 'fs_read'],
  runtime: {
    subagents: {
      depth: 2,           // Max nesting depth
      templates: ['researcher', 'coder'],  // Allowed templates
      inheritConfig: true,
      overrides: {
        permission: { mode: 'auto' },
      },
    },
  },
};
```

---

## Patterns

### Coordinator Pattern

One Agent coordinates multiple specialists.

```typescript
// Coordinator template
const coordinatorTemplate: AgentTemplateDefinition = {
  id: 'coordinator',
  systemPrompt: `You are a project coordinator. Break down complex tasks and delegate to specialists:
- Use 'researcher' for information gathering
- Use 'coder' for implementation
- Use 'reviewer' for code review

Coordinate the work and synthesize results.`,
  tools: ['task_run', 'fs_read', 'fs_write'],
  runtime: {
    subagents: {
      depth: 1,
      templates: ['researcher', 'coder', 'reviewer'],
    },
  },
};

// Usage
const coordinator = await Agent.create({
  templateId: 'coordinator',
  ...
}, deps);

await coordinator.send('Implement a user authentication system');
// Coordinator will delegate:
// 1. researcher: "Research auth best practices"
// 2. coder: "Implement auth module"
// 3. reviewer: "Review auth implementation"
```

### Pipeline Pattern

Chain Agents in sequence.

```typescript
async function pipeline(input: string) {
  // Step 1: Research
  const researcher = await pool.create('researcher-1', {
    templateId: 'researcher',
    ...
  });
  const research = await researcher.send(`Research: ${input}`);

  // Step 2: Implement
  const coder = await pool.create('coder-1', {
    templateId: 'coder',
    ...
  });
  const implementation = await coder.send(`
    Based on this research:
    ${research}

    Implement the solution.
  `);

  // Step 3: Review
  const reviewer = await pool.create('reviewer-1', {
    templateId: 'reviewer',
    ...
  });
  const review = await reviewer.send(`
    Review this implementation:
    ${implementation}
  `);

  return { research, implementation, review };
}
```

### Debate Pattern

Multiple Agents discuss a topic.

```typescript
const room = new Room(pool);

// Create debaters
const alice = await pool.create('alice', {
  templateId: 'debater',
  metadata: { position: 'pro' },
  ...
});
const bob = await pool.create('bob', {
  templateId: 'debater',
  metadata: { position: 'con' },
  ...
});

room.join('Alice', 'alice');
room.join('Bob', 'bob');

// Start debate
await room.say('Moderator', 'Topic: Should we use microservices?');

// Continue debate rounds
for (let round = 0; round < 3; round++) {
  await room.say('Alice', `@Bob [Round ${round + 1}] Here's my argument...`);
  await room.say('Bob', `@Alice [Round ${round + 1}] My counterargument...`);
}
```

---

## Best Practices

### 1. Limit Depth

Prevent infinite sub-agent chains:

```typescript
runtime: {
  subagents: {
    depth: 2,  // Maximum nesting depth
  },
}
```

### 2. Clear Templates

Each template should have clear responsibilities:

```typescript
const templates: AgentTemplate[] = [
  {
    id: 'data-analyst',
    whenToUse: 'Analyze data patterns and generate insights',
    tools: ['fs_read', 'fs_glob'],
  },
  // Avoid overlapping responsibilities
];
```

### 3. Resource Management

Clean up agents when done:

```typescript
try {
  const agent = await pool.create('temp-agent', config);
  const result = await agent.send(message);
  return result;
} finally {
  await pool.destroy('temp-agent');
}
```

### 4. Permission Inheritance

Consider permission settings for sub-agents:

```typescript
runtime: {
  subagents: {
    inheritConfig: true,
    overrides: {
      permission: { mode: 'approval' },  // Require approval
    },
  },
}
```

---

## Monitoring Multi-Agent Systems

### Track Sub-Agent Events

```typescript
agent.on('tool_executed', (event) => {
  if (event.call.name === 'task_run') {
    console.log('Sub-agent completed:', {
      template: event.call.result?.template,
      status: event.call.result?.status,
    });
  }
});
```

### Aggregate Metrics

```typescript
const allAgentIds = pool.list();
const stats = await Promise.all(
  allAgentIds.map(async (id) => {
    const status = await pool.status(id);
    return { id, ...status };
  })
);

console.log('Total agents:', stats.length);
console.log('Working:', stats.filter(s => s.state === 'WORKING').length);
console.log('Paused:', stats.filter(s => s.state === 'PAUSED').length);
```

---

## References

- [API Reference](../reference/api.md)
- [Events Guide](../guides/events.md)
- [Production Deployment](./production.md)
