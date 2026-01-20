# KODE SDK · Event-Driven Agent Runtime

> **就像和资深同事协作**：发消息、批示、打断、分叉、续上 —— 一套最小而够用的 API，驱动长期在线的多 Agent 系统。

## Why KODE

- **Event-First**：UI 只订阅 Progress（文本/工具流）；审批与治理走 Control & Monitor 回调，默认不推噪音事件。
- **长时运行 + 可分叉**：七段断点恢复（READY → POST_TOOL），Safe-Fork-Point 天然存在于工具结果与纯文本处，一键 fork 继续。
- **同事式协作心智**：Todo 管理、提醒、Tool 手册自动注入，工具并发可限流，默认配置即安全可用。
- **高性能且可审计**：统一 WAL、零拷贝文本流、工具拒绝必落审计、Monitor 事件覆盖 token 用量、错误与文件变更。
- **可扩展生态**：原生接入 MCP 工具、Sandbox 驱动、模型 Provider、Store 后端、Scheduler DSL，支持企业级自定义。

## 60 秒上手：跑通第一个“协作收件箱”

```bash
npm install @shareai-lab/kode-sdk
export ANTHROPIC_API_KEY=sk-...        # 或 ANTHROPIC_API_TOKEN
export ANTHROPIC_BASE_URL=https://...   # 可选，默认为官方 API
export ANTHROPIC_MODEL_ID=claude-sonnet-4.5-20250929  # 可选

npm run example:agent-inbox
```

输出中你会看到：

- Progress 渠道实时流式文本 / 工具生命周期事件
- Control 渠道的审批请求（示例中默认拒绝 `bash_run`）
- Monitor 渠道的工具审计日志（耗时、审批结果、错误）

想自定义行为？修改 `examples/01-agent-inbox.ts` 内的模板、工具与事件订阅即可。

## 示例游乐场

| 示例 | 用例 | 涵盖能力 |
| --- | --- | --- |
| `npm run example:getting-started` | 最小对话循环 | Progress 流订阅、Anthropic 模型直连 |
| `npm run example:agent-inbox` | 事件驱动收件箱 | Todo 管理、工具并发、Monitor 审计 |
| `npm run example:approval` | 工具审批工作流 | Control 回调、Hook 策略、自动拒绝/放行 |
| `npm run example:room` | 多 Agent 协作 | AgentPool、Room 消息、Safe Fork、Lineage |
| `npm run example:scheduler` | 长时运行 & 提醒 | Scheduler 步数触发、系统提醒、FilePool 监控 |
| `npm run example:nextjs` | API + SSE | Resume-or-create、Progress 流推送（无需安装 Next） |

每个示例都位于 `examples/` 下，对应 README 中的学习路径，展示事件驱动、审批、安全、调度、协作等核心能力的组合方式。

## 构建属于你的协作型 Agent

1. **理解三通道心智**：详见 [`docs/events.md`](./docs/events.md)。
2. **跟着 Quickstart 实战**：[`docs/quickstart.md`](./docs/quickstart.md) 从 “依赖注入 → Resume → SSE” 手把手搭建服务。
3. **扩展用例**：[`docs/playbooks.md`](./docs/playbooks.md) 涵盖审批治理、多 Agent 小组、调度提醒等典型场景。
4. **查阅 API**：[`docs/api.md`](./docs/api.md) 枚举 `Agent`、`EventBus`、`ToolRegistry` 等核心类型与事件。
5. **深挖能力**：Todo、ContextManager、Scheduler、Sandbox、Hook、Tool 定义详见 `docs/` 目录。

## 基础设计一图流

```
Client/UI ── subscribe(['progress']) ──┐
Approval service ── Control 回调 ─────┼▶ EventBus（三通道）
Observability ── Monitor 事件 ────────┘

             │
             ▼
   MessageQueue → ContextManager → ToolRunner
             │             │             │
             ▼             ▼             ▼
        Store (WAL)    FilePool      PermissionManager
```

## Provider Adapter Pattern

KODE SDK uses **Anthropic-style messages as the internal canonical format**. All model providers are implemented as adapters that convert to/from this internal format, enabling seamless switching between providers while maintaining a consistent message structure.

### Internal Message Format

```typescript
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  metadata?: {
    content_blocks?: ContentBlock[];
    transport?: 'provider' | 'text' | 'omit';
  };
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; reasoning: string; meta?: { signature?: string } }
  | { type: 'image'; base64?: string; url?: string; mime_type?: string; file_id?: string }
  | { type: 'audio'; base64?: string; url?: string; mime_type?: string }
  | { type: 'file'; base64?: string; url?: string; filename?: string; mime_type?: string; file_id?: string }
  | { type: 'tool_use'; id: string; name: string; input: any; meta?: Record<string, any> }
  | { type: 'tool_result'; tool_use_id: string; content: any; is_error?: boolean };
```

### Message Flow

```
Internal Message[] (Anthropic-style ContentBlocks)
  -> Provider.formatMessages() -> External API format
  -> API call
  -> Response -> normalizeContent() -> Internal ContentBlock[]
```

### Supported Providers

| Provider | API | Thinking Support | Files | Streaming |
|----------|-----|------------------|-------|-----------|
| Anthropic | Messages API | Extended Thinking (`interleaved-thinking-2025-05-14`) | Files API | SSE |
| OpenAI | Chat Completions | `<think>` tags | - | SSE |
| OpenAI | Responses API | `reasoning_effort` (store, previous_response_id) | File uploads | SSE |
| Gemini | Generate Content | `thinkingLevel` (3.x) | GCS URIs | SSE |
| DeepSeek | Chat Completions | `reasoning_content` (auto-strip from history) | - | SSE |
| Qwen | Chat Completions | `thinking_budget` | - | SSE |
| GLM | Chat Completions | `thinking.type: enabled` | - | SSE |
| Minimax | Chat Completions | `reasoning_split` | - | SSE |
| Kimi K2 | Chat Completions | `reasoning` field | - | SSE |
| Groq/Cerebras | Chat Completions | OpenAI-compatible | - | SSE |

---

## Provider Message Conversion Details

### Anthropic Provider

**API Format**: Anthropic Messages API with extended thinking beta

```typescript
// Internal -> Anthropic
{
  role: 'user' | 'assistant',
  content: [
    { type: 'text', text: '...' },
    { type: 'thinking', thinking: '...', signature?: '...' },  // Extended thinking
    { type: 'image', source: { type: 'base64', media_type: '...', data: '...' } },
    { type: 'document', source: { type: 'file', file_id: '...' } },  // Files API
    { type: 'tool_use', id: '...', name: '...', input: {...} },
    { type: 'tool_result', tool_use_id: '...', content: '...' }
  ]
}
```

**Extended Thinking Configuration**:
```typescript
const provider = new AnthropicProvider(apiKey, model, baseUrl, proxyUrl, {
  reasoningTransport: 'provider',  // 'provider' | 'text' | 'omit'
  thinking: {
    enabled: true,
    budgetTokens: 10000  // Maps to thinking.budget_tokens
  }
});
```

**Beta Headers**: Automatically added based on message content:
- `interleaved-thinking-2025-05-14`: When `reasoningTransport === 'provider'`
- `files-api-2025-04-14`: When messages contain file blocks with `file_id`

**Signature Preservation**: Critical for multi-turn conversations with Claude 4+. The SDK preserves thinking block signatures in `meta.signature`.

---

### OpenAI Provider (Chat Completions API)

**API Format**: OpenAI Chat Completions

```typescript
// Internal -> OpenAI Chat
{
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: '...' | [{ type: 'text', text: '...' }, { type: 'image_url', image_url: { url: '...' } }],
  tool_calls?: [{ id: '...', type: 'function', function: { name: '...', arguments: '...' } }],
  reasoning_content?: '...',  // DeepSeek/GLM/Qwen/Kimi
  reasoning_details?: [{ text: '...' }]  // Minimax
}
```

**Configuration-Driven Reasoning** (NEW in v2.7):

The OpenAI provider now uses a configuration-driven approach instead of hardcoded provider detection:

```typescript
// ReasoningConfig interface
interface ReasoningConfig {
  fieldName?: 'reasoning_content' | 'reasoning_details';  // Response field name
  requestParams?: Record<string, any>;  // Enable reasoning in request
  stripFromHistory?: boolean;  // DeepSeek requirement
}
```

**Provider-Specific Configuration Examples**:

```typescript
// DeepSeek (must strip reasoning from history)
const deepseekProvider = new OpenAIProvider(apiKey, 'deepseek-reasoner', baseUrl, undefined, {
  reasoningTransport: 'provider',
  reasoning: {
    fieldName: 'reasoning_content',
    stripFromHistory: true,  // Critical: DeepSeek returns 400 if reasoning in history
  },
});

// GLM (thinking.type parameter)
const glmProvider = new OpenAIProvider(apiKey, 'glm-4.7', baseUrl, undefined, {
  reasoningTransport: 'provider',
  reasoning: {
    fieldName: 'reasoning_content',
    requestParams: { thinking: { type: 'enabled', clear_thinking: false } },
  },
});

// Minimax (reasoning_split parameter, reasoning_details field)
const minimaxProvider = new OpenAIProvider(apiKey, 'minimax-moe-01', baseUrl, undefined, {
  reasoningTransport: 'provider',
  reasoning: {
    fieldName: 'reasoning_details',
    requestParams: { reasoning_split: true },
  },
});

// Qwen (enable_thinking parameter)
const qwenProvider = new OpenAIProvider(apiKey, 'qwen3-max', baseUrl, undefined, {
  reasoningTransport: 'provider',
  reasoning: {
    fieldName: 'reasoning_content',
    requestParams: { enable_thinking: true, thinking_budget: 10000 },
    stripFromHistory: true,  // Similar to DeepSeek
  },
});

// Kimi K2 (reasoning parameter)
const kimiProvider = new OpenAIProvider(apiKey, 'kimi-k2-thinking', baseUrl, undefined, {
  reasoningTransport: 'provider',
  reasoning: {
    fieldName: 'reasoning_content',
    requestParams: { reasoning: 'enabled' },
  },
});
```

**Tool Message Conversion**:
```typescript
// Internal tool_result -> OpenAI tool message
{ role: 'tool', tool_call_id: '...', content: '...', name: '...' }
```

**Image Handling**:
- URL images: `{ type: 'image_url', image_url: { url: 'https://...' } }`
- Base64 images: `{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }`

**Reasoning Transport**:
- `text`: Reasoning wrapped as `<think>...</think>` in text content
- `provider`: Uses provider-specific fields (configured via `reasoning.fieldName`)

---

### OpenAI Provider (Responses API)

**API Format**: OpenAI Responses API (GPT-5.x reasoning models)

```typescript
// Internal -> OpenAI Responses
{
  model: 'gpt-5.2',
  input: [
    { role: 'user', content: [{ type: 'input_text', text: '...' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: '...' }] }
  ],
  reasoning?: { effort: 'medium' },  // none | minimal | low | medium | high | xhigh
  store?: true,  // Enable state persistence
  previous_response_id?: 'resp_...'  // Multi-turn continuation
}
```

**File Handling**:
```typescript
// File with ID
{ type: 'input_file', file_id: '...' }
// File with URL
{ type: 'input_file', file_url: '...' }
// File with base64
{ type: 'input_file', filename: '...', file_data: 'data:application/pdf;base64,...' }
```

**Configuration** (NEW in v2.7):
```typescript
const provider = new OpenAIProvider(apiKey, 'gpt-5.2', baseUrl, undefined, {
  api: 'responses',  // Use Responses API instead of Chat Completions
  responses: {
    reasoning: { effort: 'high' },  // Reasoning effort level
    store: true,  // Enable response storage for continuation
    previousResponseId: 'resp_abc123',  // Resume from previous response
  },
});
```

**Multi-Turn Conversation Flow**:
```typescript
// First request
const response1 = await provider.complete(messages);
const responseId = response1.metadata?.responseId;  // Store for continuation

// Second request (continues from first)
provider.configure({
  responses: { ...provider.getConfig().responses, previousResponseId: responseId }
});
const response2 = await provider.complete(newMessages);
```

---

### Gemini Provider

**API Format**: Gemini Generate Content API

```typescript
// Internal -> Gemini
{
  contents: [
    {
      role: 'user' | 'model',
      parts: [
        { text: '...' },
        { inline_data: { mime_type: '...', data: '...' } },  // Base64 images/files
        { file_data: { mime_type: '...', file_uri: 'gs://...' } },  // GCS files
        { functionCall: { name: '...', args: {...} } },
        { functionResponse: { name: '...', response: { content: '...' } } }
      ]
    }
  ],
  systemInstruction?: { parts: [{ text: '...' }] },
  tools?: [{ functionDeclarations: [...] }],
  generationConfig?: {
    temperature: 0.7,
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingLevel: 'HIGH' }  // Gemini 3.x
  }
}
```

**Role Mapping**:
- `assistant` -> `model`
- `user` -> `user`
- `system` -> `systemInstruction`

**Thinking Configuration** (Gemini 3.x):
```typescript
const provider = new GeminiProvider(apiKey, model, baseUrl, proxyUrl, {
  thinking: {
    level: 'high'  // minimal | low | medium | high -> MINIMAL | LOW | MEDIUM | HIGH
  }
});
```

**Tool Schema Sanitization**: Gemini requires clean JSON Schema without:
- `additionalProperties`
- `$schema`
- `$defs`
- `definitions`

---

### High-Speed Inference Providers (Groq/Cerebras)

Both Groq and Cerebras provide OpenAI-compatible APIs with extremely fast inference speeds:

**Groq** (LPU Inference Engine):
```typescript
const groqProvider = new OpenAIProvider(apiKey, 'llama-3.3-70b-versatile', undefined, undefined, {
  baseUrl: 'https://api.groq.com/openai/v1',  // Auto-appends /v1
  // Reasoning models (Qwen 3 32B, QwQ-32B)
  reasoning: {
    fieldName: 'reasoning_content',
    requestParams: { reasoning_format: 'parsed', reasoning_effort: 'default' },
  },
});
// Speed: ~276 tokens/second for Llama 3.3 70B
```

**Cerebras** (Wafer-Scale Engine):
```typescript
const cerebrasProvider = new OpenAIProvider(apiKey, 'qwen-3-32b', undefined, undefined, {
  baseUrl: 'https://api.cerebras.ai/v1',
  reasoning: {
    fieldName: 'reasoning_content',
    requestParams: { reasoning_format: 'separate' },
  },
});
// Speed: ~2,600 tokens/second for Qwen3 32B
```

**Key Features**:
- OpenAI-compatible Chat Completions API
- Tool calling with `strict` mode (Cerebras)
- Streaming support with SSE
- Rate limits: 50 RPM (Cerebras), higher for Groq paid tiers

---

## ReasoningTransport Options

Controls how thinking/reasoning content is handled across providers:

| Transport | Description | Use Case |
|-----------|-------------|----------|
| `provider` | Native provider format (Anthropic thinking blocks, OpenAI reasoning tokens) | Full thinking visibility, multi-turn conversations |
| `text` | Wrapped in `<think>...</think>` tags as text | Cross-provider compatibility, text-based pipelines |
| `omit` | Excluded from message history | Privacy, token reduction |

---

## Prompt Caching

The SDK supports prompt caching across multiple providers for significant cost savings:

| Provider | Caching Type | Min Tokens | TTL | Savings |
|----------|--------------|------------|-----|---------|
| Anthropic | Explicit (`cache_control`) | 1024-4096 | 5m/1h | 90% |
| OpenAI | Automatic | 1024 | 24h | 75% |
| Gemini | Implicit + Explicit | 256-4096 | Custom | 75% |
| DeepSeek | Automatic prefix | 64 | Hours | 90% |
| Qwen | Explicit (`cache_control`) | 1024 | 5m | 90% |

**Anthropic Cache Example**:
```typescript
const provider = new AnthropicProvider(apiKey, 'claude-sonnet-4.5', baseUrl, undefined, {
  beta: { extendedCacheTtl: true },  // Enable 1-hour TTL
  cache: { breakpoints: 4, defaultTtl: '1h' },
});

// Mark content for caching in messages
const messages = [{
  role: 'user',
  content: [{
    type: 'text',
    text: 'Large document...',
    cacheControl: { type: 'ephemeral', ttl: '1h' }
  }]
}];
```

**Usage Tracking**:
```typescript
const response = await provider.complete(messages);
console.log(response.usage);
// {
//   input_tokens: 100,
//   cache_creation_input_tokens: 50000,  // First request
//   cache_read_input_tokens: 50000,      // Subsequent requests
//   output_tokens: 500
// }
```

---

## Session Compression & Resume

The SDK's context management works with all providers:

1. **Message Windowing**: Automatically manages context window limits per provider
2. **Safe Fork Points**: Natural breakpoints at tool results and pure text responses
3. **Reasoning Preservation**: Thinking blocks can be:
   - Preserved with signatures (Anthropic)
   - Converted to text tags (cross-provider)
   - Omitted for compression

```typescript
// Resume with thinking context
const agent = await Agent.resume(sessionId, {
  provider: new AnthropicProvider(apiKey, model, baseUrl, undefined, {
    reasoningTransport: 'provider'  // Preserve thinking for continuation
  })
});
```

---

## Testing Providers

Run integration tests with real API connections:

```bash
# Configure credentials
cp .env.test.example .env.test
# Edit .env.test with your API keys

# Run all provider tests
npm test -- --testPathPattern="multi-provider"

# Run specific provider
npm test -- --testPathPattern="multi-provider" --testNamePattern="Anthropic"
```

---

## 下一步

- 使用 `examples/` 作为蓝本接入你自己的工具、存储、审批系统。
- 将 Monitor 事件接入现有 observability 平台，沉淀治理与审计能力。
- 参考 `docs/` 中的扩展指南，为企业自定义 Sandbox、模型 Provider 或多团队 Agent 协作流程。

欢迎在 Issue / PR 中分享反馈与场景诉求，让 KODE SDK 更贴近真实协作团队的需求。
