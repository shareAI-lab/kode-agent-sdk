# Extended Thinking Guide

KODE SDK supports extended thinking (also known as reasoning or chain-of-thought) features from various LLM providers. This guide covers how to enable, configure, and use thinking capabilities including interleaved thinking.

---

## Overview

Extended thinking allows models to "think" through complex problems step-by-step before providing a final answer. Different providers implement this differently:

| Provider | Feature Name | Implementation |
|----------|--------------|----------------|
| Anthropic | Extended Thinking | `thinking` blocks with budget tokens |
| OpenAI | Reasoning | `reasoning_effort` parameter |
| Gemini | Thinking | `thinkingLevel` parameter |
| DeepSeek | Deep Think | `reasoning_content` field |
| GLM | Thinking | `reasoning_content` field |
| Minimax | Reasoning | `reasoning_details` field |

---

## Agent Configuration

### Enable Thinking Exposure

Configure thinking exposure when creating an Agent:

```typescript
const agent = await Agent.create({
  templateId: 'reasoning-assistant',
  // Expose thinking events to Progress channel
  exposeThinking: true,
  // Retain thinking blocks in message history
  retainThinking: true,
}, deps);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `exposeThinking` | `boolean` | `false` | Emit `think_chunk_start`, `think_chunk`, `think_chunk_end` events |
| `retainThinking` | `boolean` | `false` | Persist reasoning blocks in message history |

---

## Provider Configuration

### Anthropic Extended Thinking

```typescript
const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-20250514',
  undefined,
  undefined,
  {
    // Enable extended thinking
    extraBody: {
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,  // Minimum 1024
      },
    },
    // How to transport reasoning in history
    reasoningTransport: 'provider',  // 'provider' | 'text' | 'omit'
    // Enable interleaved thinking beta
    beta: {
      interleavedThinking: true,  // interleaved-thinking-2025-05-14
    },
  }
);
```

### OpenAI Reasoning

```typescript
const provider = new OpenAIProvider(
  process.env.OPENAI_API_KEY!,
  'o3-mini',
  undefined,
  undefined,
  {
    api: 'responses',  // Responses API required for reasoning
    responses: {
      reasoning: {
        effort: 'medium',  // 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      },
    },
    reasoningTransport: 'text',
  }
);
```

### Gemini Thinking

```typescript
const provider = new GeminiProvider(
  process.env.GOOGLE_API_KEY!,
  'gemini-2.5-pro',
  undefined,
  undefined,
  {
    thinking: {
      level: 'medium',  // 'minimal' | 'low' | 'medium' | 'high'
    },
    reasoningTransport: 'text',
  }
);
```

### DeepSeek / GLM / Qwen

These providers use OpenAI-compatible API with custom reasoning fields:

```typescript
// DeepSeek
const provider = new OpenAIProvider(
  process.env.DEEPSEEK_API_KEY!,
  'deepseek-reasoner',
  'https://api.deepseek.com/v1',
  undefined,
  {
    reasoning: {
      fieldName: 'reasoning_content',
      stripFromHistory: true,  // Required for DeepSeek
    },
    reasoningTransport: 'text',
  }
);

// GLM
const provider = new OpenAIProvider(
  process.env.GLM_API_KEY!,
  'glm-zero-preview',
  process.env.GLM_BASE_URL!,
  undefined,
  {
    reasoning: {
      fieldName: 'reasoning_content',
      requestParams: {
        thinking: { type: 'enabled', clear_thinking: false },
      },
    },
    reasoningTransport: 'provider',
  }
);
```

---

## Reasoning Transport

The `reasoningTransport` option controls how thinking content is handled in message history:

| Value | Behavior | Use Case |
|-------|----------|----------|
| `'provider'` | Keep as native `reasoning` blocks | Full thinking preservation, multi-turn continuity |
| `'text'` | Wrap in `<think></think>` tags | Cross-provider compatibility |
| `'omit'` | Remove from history | Save tokens, privacy |

```typescript
// Provider native format
const config = {
  reasoningTransport: 'provider',  // { type: 'reasoning', reasoning: '...' }
};

// Text format
const config = {
  reasoningTransport: 'text',  // { type: 'text', text: '<think>...</think>' }
};

// Omit from history
const config = {
  reasoningTransport: 'omit',  // Thinking blocks removed
};
```

---

## Interleaved Thinking

Interleaved thinking allows the model to think between tool calls, enabling more sophisticated reasoning:

```
User: Search for X, then summarize
Model: <thinking> Let me search for X first... </thinking>
Model: [tool_use: search_tool]
[tool_result]
Model: <thinking> Got results, now I should summarize... </thinking>
Model: [tool_use: summarize_tool]
[tool_result]
Model: <thinking> Combining everything... </thinking>
Model: Here's the summary...
```

### Enable Interleaved Thinking

```typescript
// Anthropic with interleaved thinking
const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-20250514',
  undefined,
  undefined,
  {
    extraBody: {
      thinking: { type: 'enabled', budget_tokens: 10000 },
    },
    beta: {
      interleavedThinking: true,
    },
    reasoningTransport: 'provider',
  }
);

const agent = await Agent.create({
  templateId: 'reasoning-agent',
  exposeThinking: true,
  retainThinking: true,
}, deps);
```

---

## Thinking Events

When `exposeThinking: true`, thinking events are emitted to the Progress channel:

```typescript
for await (const envelope of agent.subscribe(['progress'])) {
  switch (envelope.event.type) {
    case 'think_chunk_start':
      // Thinking block started
      console.log('[Thinking...]');
      break;

    case 'think_chunk':
      // Thinking content delta
      process.stdout.write(envelope.event.delta);
      break;

    case 'think_chunk_end':
      // Thinking block ended
      console.log('[/Thinking]');
      break;

    case 'tool:start':
      console.log(`[Tool: ${envelope.event.call.name}]`);
      break;

    case 'text_chunk':
      process.stdout.write(envelope.event.delta);
      break;

    case 'done':
      break;
  }
}
```

### Event Sequence

Typical interleaved thinking sequence:

```
think_chunk_start -> think_chunk (x N) -> think_chunk_end
  -> tool:start -> tool:end
think_chunk_start -> think_chunk (x N) -> think_chunk_end
  -> tool:start -> tool:end
think_chunk_start -> think_chunk (x N) -> think_chunk_end
  -> text_chunk_start -> text_chunk (x N) -> text_chunk_end
  -> done
```

---

## ThinkingOptions

Configure thinking via `CompletionOptions.thinking`:

```typescript
interface ThinkingOptions {
  enabled?: boolean;          // Enable thinking mode
  budgetTokens?: number;      // Token budget (Anthropic, Gemini 2.5)
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';  // OpenAI
  level?: 'minimal' | 'low' | 'medium' | 'high';  // Gemini 3.x
}
```

---

## Best Practices

### 1. Choose Appropriate Budget

Higher budget = more thorough thinking but slower and more expensive:

```typescript
// Quick tasks: lower budget
const quickThinking = { type: 'enabled', budget_tokens: 2000 };

// Complex reasoning: higher budget
const deepThinking = { type: 'enabled', budget_tokens: 16000 };
```

### 2. Use `retainThinking` for Multi-Turn Reasoning

For conversations requiring continuity of reasoning:

```typescript
const agent = await Agent.create({
  templateId: 'analyst',
  exposeThinking: true,
  retainThinking: true,  // Keep reasoning for context
}, deps);
```

### 3. Strip Thinking for Token Savings

If thinking is only for single-turn and not needed in history:

```typescript
const provider = new AnthropicProvider(apiKey, model, undefined, undefined, {
  reasoningTransport: 'omit',  // Don't persist thinking
  extraBody: {
    thinking: { type: 'enabled', budget_tokens: 5000 },
  },
});

const agent = await Agent.create({
  templateId: 'solver',
  exposeThinking: true,   // Show thinking to user
  retainThinking: false,  // Don't persist
}, deps);
```

### 4. Prompt for Interleaved Thinking

Encourage the model to think between steps:

```typescript
const prompt = `
I need to analyze this data. Please:
1. First, use the fetch_data tool to get the data
2. Think about what patterns you see
3. Use the analyze_tool to run analysis
4. Think about the implications
5. Provide your conclusions

Think carefully between each step.
`;

await agent.send(prompt);
```

---

## Complete Example

```typescript
import {
  Agent,
  AnthropicProvider,
  JSONStore,
  defineTool,
} from '@shareai-lab/kode-sdk';

// Define tools
const searchTool = defineTool({
  name: 'search',
  description: 'Search for information',
  params: {
    query: { type: 'string', description: 'Search query' }
  },
  async exec(args) {
    return { results: `Results for: ${args.query}` };
  }
});

async function reasoningAgent() {
  // Configure provider with extended thinking
  const provider = new AnthropicProvider(
    process.env.ANTHROPIC_API_KEY!,
    'claude-sonnet-4-20250514',
    undefined,
    undefined,
    {
      extraBody: {
        thinking: { type: 'enabled', budget_tokens: 10000 },
      },
      beta: {
        interleavedThinking: true,
      },
      reasoningTransport: 'provider',
    }
  );

  const store = new JSONStore('./.kode');

  // Create agent with thinking enabled
  const agent = await Agent.create({
    templateId: 'reasoning-assistant',
    exposeThinking: true,
    retainThinking: true,
  }, {
    store,
    templateRegistry,
    toolRegistry,
    sandboxFactory,
    modelFactory: () => provider,
  });

  // Listen for progress events
  const progressTask = (async () => {
    for await (const envelope of agent.subscribe(['progress'])) {
      const event = envelope.event;

      if (event.type === 'think_chunk_start') {
        process.stdout.write('\n[Thinking] ');
      } else if (event.type === 'think_chunk') {
        process.stdout.write(event.delta);
      } else if (event.type === 'think_chunk_end') {
        process.stdout.write(' [/Thinking]\n');
      } else if (event.type === 'tool:start') {
        console.log(`\n[Tool: ${event.call.name}]`);
      } else if (event.type === 'text_chunk') {
        process.stdout.write(event.delta);
      } else if (event.type === 'done') {
        break;
      }
    }
  })();

  // Send task requiring reasoning
  await agent.send(`
    Research "machine learning trends" using the search tool,
    then provide a thoughtful analysis. Think step by step.
  `);

  await progressTask;
}
```

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| No thinking events | `exposeThinking: false` | Set `exposeThinking: true` |
| Thinking not retained | `retainThinking: false` | Set `retainThinking: true` |
| Thinking stripped from history | `reasoningTransport: 'omit'` | Use `'provider'` or `'text'` |
| No interleaving with tools | Beta not enabled | Enable `beta.interleavedThinking` |
| "Thinking signature invalid" error | Modified thinking blocks | Don't modify reasoning content |

---

## References

- [Provider Guide](./providers.md) - Provider-specific thinking configuration
- [Events Guide](./events.md) - Progress event handling
- [Tools Guide](./tools.md) - Tool integration
- [API Reference](../reference/api.md) - ThinkingOptions interface
