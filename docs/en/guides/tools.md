# Tool System Guide

KODE SDK provides a comprehensive tool system with built-in tools, custom tool definition APIs, and MCP integration. All tools follow these conventions:

- **Prompt Instructions**: Each tool includes detailed prompts guiding the model's safe usage
- **Structured Returns**: Tools return JSON structures (e.g., `fs_read` returns `{ content, offset, limit, truncated }`)
- **FilePool Integration**: File tools automatically validate and record through FilePool, preventing freshness conflicts
- **Audit Trail**: ToolCallRecord captures approval, duration, and errors, fully restored on Resume

---

## Built-in Tools

### File System Tools

| Tool | Description | Returns |
|------|-------------|---------|
| `fs_read` | Read file segment | `{ path, offset, limit, truncated, content }` |
| `fs_write` | Create/overwrite file with freshness validation | `{ ok, path, bytes, length }` |
| `fs_edit` | Precise text replacement (supports `replace_all`) | `{ ok, path, replacements, length }` |
| `fs_glob` | Match files using glob patterns | `{ ok, pattern, cwd, matches, truncated }` |
| `fs_grep` | Search text/regex in files or wildcard sets | `{ ok, pattern, path, matches[] }` |
| `fs_multi_edit` | Batch edit multiple files | `{ ok, results[{ path, status, replacements, message? }] }` |

#### FilePool

- `recordRead` / `recordEdit`: Track last read/write times for conflict detection
- `validateWrite`: Verify file wasn't externally modified after Agent's last read
- `watchFiles`: Auto-monitor file changes, triggers `monitor.file_changed` event

### Bash Tools

- `bash_run`: Execute commands (foreground/background), controllable via Hooks or `permission.mode='approval'`
- `bash_logs`: Read background command output
- `bash_kill`: Terminate background commands

**Recommended Security Strategy:**

```typescript
const agent = await Agent.create({
  templateId: 'secure-runner',
  sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true },
  overrides: {
    hooks: {
      preToolUse(call) {
        if (call.name === 'bash_run' && !/^git /.test(call.args.cmd)) {
          return { decision: 'ask', meta: { reason: 'Non-whitelisted command' } };
        }
        return undefined;
      },
    },
  },
}, deps);
```

### Todo Tools

- `todo_read`: Return Todo list
- `todo_write`: Write complete Todo list (validates unique IDs, max 1 in-progress). Integrates with `TodoManager` for auto-reminders and events.

### Task (Sub-Agent)

- `task_run`: Dispatch sub-Agents from template pool, supports `subagent_type`, `context`, `model_name` parameters
- Templates can limit depth and available templates via `runtime.subagents`

### Skills Tool

> **⚠️ Note**: Default Skills directory has changed from `skills/` to `.skills/`. See [Skills System Guide - Breaking Changes](./skills.md#breaking-changes)

- `skills`: Load specific skill content (instructions, references, scripts, assets)
  - **Parameters**:
    - `action`: Operation type (currently only `load`, `list` operation is disabled)
    - `skill_name`: Skill name (required when action=load)
  - **Returns**:
    ```typescript
    {
      ok: true,
      data: {
        name: string,           // Skill name (folder name)
        description: string,    // Skill description
        content: string,        // SKILL.md content
        base_dir: string,       // Skill base directory
        references: string[],   // Reference document list
        scripts: string[],      // Available scripts
        assets: string[]        // Asset files
      }
    }
    ```

See [skills.md](./skills.md) for complete Skills system documentation.

---

## Defining Custom Tools

### Quick Start with `defineTool()` (Recommended)

The simplified API (v2.7+) auto-generates JSON Schema from parameter definitions:

```typescript
import { defineTool } from '@shareai-lab/kode-sdk';

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get weather information',

  // Concise parameter definition - auto-generates Schema
  params: {
    city: {
      type: 'string',
      description: 'City name'
    },
    units: {
      type: 'string',
      description: 'Temperature units',
      enum: ['celsius', 'fahrenheit'],
      required: false,
      default: 'celsius'
    }
  },

  // Simplified attributes
  attributes: {
    readonly: true,   // Read-only tool
    noEffect: true    // No side effects, safe to retry
  },

  async exec(args, ctx) {
    // Custom events
    ctx.emit('weather_fetched', { city: args.city });
    return { temperature: 22, condition: 'sunny' };
  }
});
```

### Batch Definition with `defineTools()`

```typescript
import { defineTools } from '@shareai-lab/kode-sdk';

const calculatorTools = defineTools([
  {
    name: 'add',
    description: 'Add two numbers',
    params: {
      a: { type: 'number' },
      b: { type: 'number' }
    },
    attributes: { readonly: true, noEffect: true },
    async exec(args, ctx) {
      return args.a + args.b;
    }
  },
  {
    name: 'multiply',
    description: 'Multiply two numbers',
    params: {
      a: { type: 'number' },
      b: { type: 'number' }
    },
    attributes: { readonly: true, noEffect: true },
    async exec(args, ctx) {
      return args.a * args.b;
    }
  }
]);
```

### Traditional ToolInstance Interface

For fine-grained control, use the classic interface:

```typescript
const registry = new ToolRegistry();

registry.register('greet', () => ({
  name: 'greet',
  description: 'Greet a person by name',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name']
  },
  prompt: 'Use this tool to greet teammates by name.',
  async exec(args) {
    return `Hello, ${args.name}!`;
  },
  toDescriptor() {
    return { source: 'registered', name: 'greet', registryId: 'greet' };
  },
}));
```

---

## Parameter Definition

### Basic Types

```typescript
params: {
  str: { type: 'string', description: 'A string' },
  num: { type: 'number', description: 'A number' },
  bool: { type: 'boolean', description: 'A boolean' },

  // Optional parameter
  optional: { type: 'string', required: false },

  // Default value
  withDefault: { type: 'number', default: 42 },

  // Enum
  choice: {
    type: 'string',
    enum: ['option1', 'option2', 'option3']
  }
}
```

### Complex Types

```typescript
params: {
  // Array
  tags: {
    type: 'array',
    description: 'List of tags',
    items: { type: 'string' }
  },

  // Nested object
  profile: {
    type: 'object',
    description: 'User profile',
    properties: {
      email: { type: 'string' },
      age: { type: 'number', required: false },
      roles: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  }
}
```

### Direct JSON Schema (Advanced)

For constraints like `pattern`, `minLength`, use `input_schema` directly:

```typescript
defineTool({
  name: 'advanced_tool',
  description: 'Advanced tool',
  input_schema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        pattern: '^[A-Z]{3}$',
        minLength: 3,
        maxLength: 3
      }
    },
    required: ['data']
  },
  async exec(args, ctx) {
    // ...
  }
});
```

---

## Tool Attributes

### `readonly` - Read-only Tool

Indicates the tool doesn't modify any state (files, database, external APIs):

```typescript
attributes: {
  readonly: true
}
```

**Use Cases**:
- Auto-approved in `readonly` permission mode
- Suitable for queries, reads, computations

### `noEffect` - No Side Effects

Indicates the tool can be safely retried with identical results:

```typescript
attributes: {
  noEffect: true
}
```

**Use Cases**:
- Safe for re-execution on Resume
- Suitable for idempotent operations (GET requests, pure calculations)

### Default Behavior

Without `attributes`, tools are treated as:
- Non-readonly (may write)
- Has side effects (cannot retry)

---

## Custom Events

### Basic Usage

```typescript
defineTool({
  name: 'process_data',
  description: 'Process data',
  params: { input: { type: 'string' } },

  async exec(args, ctx: EnhancedToolContext) {
    ctx.emit('processing_started', { input: args.input });
    const result = await heavyComputation(args.input);
    ctx.emit('processing_completed', { result, duration: 1234 });
    return result;
  }
});
```

### Listening to Custom Events

```typescript
agent.on('tool_custom_event', (event) => {
  console.log(`[${event.toolName}] ${event.eventType}:`, event.data);
});
```

### Event Structure

```typescript
interface MonitorToolCustomEvent {
  channel: 'monitor';
  type: 'tool_custom_event';
  toolName: string;        // Tool name
  eventType: string;       // Custom event type
  data?: any;              // Event data
  timestamp: number;
  bookmark?: Bookmark;
}
```

---

## Tool Timeout & AbortSignal

### Timeout Configuration

Default tool execution timeout is **60 seconds**, customizable via Agent config:

```typescript
const agent = await Agent.create({
  templateId: 'my-assistant',
  metadata: {
    toolTimeoutMs: 120000, // 2 minutes
  }
}, deps);
```

### Handling AbortSignal (Required)

All custom tools receive `context.signal` - **must** check in long-running operations:

```typescript
export class MyLongRunningTool implements ToolInstance {
  async exec(args: any, context: ToolContext) {
    // Check before long operations
    if (context.signal?.aborted) {
      throw new Error('Operation aborted');
    }

    // Pass signal to underlying APIs
    const response = await fetch(url, { signal: context.signal });

    // Check periodically in loops
    for (const item of items) {
      if (context.signal?.aborted) {
        throw new Error('Operation aborted');
      }
      await processItem(item);
    }

    return result;
  }
}
```

### CPU-Intensive Tasks

For pure computation tasks, actively check in loops:

```typescript
for (let i = 0; i < args.iterations; i++) {
  // Check every 100 iterations
  if (i % 100 === 0 && context.signal?.aborted) {
    throw new Error('Computation aborted');
  }
  result.push(this.compute(i));
}
```

### Timeout Recovery

After timeout, Agent will:
1. Send `abort` signal
2. Mark tool call as `FAILED`
3. Generate `tool_result` with timeout info
4. Continue to next `runStep`

On Resume, timed-out tool calls are auto-sealed (Auto-Seal), not re-executed.

---

## MCP Integration

Register MCP loaders in ToolRegistry with `registryId` pointing to MCP service:

```typescript
const registry = new ToolRegistry();

// Register MCP tool loader
registry.registerMCPLoader('my-mcp-server', async () => {
  const client = await connectToMCPServer('my-mcp-server');
  return client.getTools();
});
```

Combined with TemplateRegistry, specify which templates enable MCP tools for proper Resume recovery.

---

## Best Practices

1. **Always check `context.signal?.aborted`** in long-running operations
2. **Pass signal to APIs supporting AbortSignal** (fetch, axios, etc.)
3. **Set appropriate `attributes`** to help permission system
4. **Use custom events** for tool execution observability
5. **Prefer `defineTool()`** for cleaner, type-safe code
6. **Use `input_schema`** only for advanced Schema constraints
7. **Monitor timeout events** for alerting

```typescript
agent.on('error', (event) => {
  if (event.phase === 'tool' && event.message.includes('aborted')) {
    console.log('Tool execution timed out:', event.detail);
  }
});
```

---

## Migration from Legacy API

### Metadata Mapping

| Legacy | New |
|--------|-----|
| `{ access: 'read', mutates: false }` | `{ readonly: true }` |
| `{ access: 'write', mutates: true }` | (default, no need to set) |
| `{ safe: true }` | `{ noEffect: true }` |

### Adding Custom Events

```typescript
// Legacy - cannot emit events
async exec(args, ctx: ToolContext) {
  return result;
}

// New - can emit events
async exec(args, ctx: EnhancedToolContext) {
  ctx.emit('event_name', { data: 'value' });
  return result;
}
```

---

## FAQ

**Q: Must I use the new API?**

A: No, the legacy `ToolInstance` interface is fully compatible. The new API is optional enhancement.

**Q: What's the difference between `readonly` and `noEffect`?**

A:
- `readonly`: Tool doesn't modify any state (files, database, etc.)
- `noEffect`: Tool can be safely retried with identical results

A read-only tool is usually also side-effect-free, but not vice versa.

**Q: Are custom events persisted?**

A: Yes, custom events are persisted to WAL as `MonitorToolCustomEvent`, recoverable on Resume.

**Q: Can I mix old and new APIs?**

A: Yes, freely mix them - Register tools in ToolRegistry and reference by name:

```typescript
const tools = new ToolRegistry();

// Register different styles
tools.register('old_tool', () => oldStyleTool);
tools.register('new_tool', () => defineTool({ name: 'new_tool', /* ... */ }));
tools.register('fs_read', () => new FsRead());

// Reference in template
templates.register({
  id: 'my-assistant',
  tools: ['old_tool', 'new_tool', 'fs_read'],
});

const agent = await Agent.create({ templateId: 'my-assistant' }, deps);
```

---

## Reference

- Example code: `examples/tooling/simplified-tools.ts`
- Type definitions: `src/tools/define.ts`
- Event system: [events.md](./events.md)
