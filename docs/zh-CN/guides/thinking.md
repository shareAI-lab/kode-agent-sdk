# 扩展思维指南

KODE SDK 支持各种 LLM Provider 的扩展思维（也称为推理或思维链）功能。本指南介绍如何启用、配置和使用思维功能，包括交错思维。

---

## 概述

扩展思维允许模型在提供最终答案之前逐步"思考"复杂问题。不同的 Provider 实现方式不同：

| Provider | 功能名称 | 实现方式 |
|----------|----------|----------|
| Anthropic | Extended Thinking | `thinking` 块 + budget tokens |
| OpenAI | Reasoning | `reasoning_effort` 参数 |
| Gemini | Thinking | `thinkingLevel` 参数 |
| DeepSeek | Deep Think | `reasoning_content` 字段 |
| GLM | Thinking | `reasoning_content` 字段 |
| Minimax | Reasoning | `reasoning_details` 字段 |

---

## Agent 配置

### 启用思维暴露

创建 Agent 时配置思维暴露：

```typescript
const agent = await Agent.create({
  templateId: 'reasoning-assistant',
  // 将思维事件暴露到 Progress 通道
  exposeThinking: true,
  // 在消息历史中保留思维块
  retainThinking: true,
}, deps);
```

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `exposeThinking` | `boolean` | `false` | 发出 `think_chunk_start`、`think_chunk`、`think_chunk_end` 事件 |
| `retainThinking` | `boolean` | `false` | 在消息历史中持久化推理块 |

---

## Provider 配置

### Anthropic 扩展思维

```typescript
const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-20250514',
  undefined,
  undefined,
  {
    // 启用扩展思维
    extraBody: {
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,  // 最小 1024
      },
    },
    // 如何在历史中传输推理
    reasoningTransport: 'provider',  // 'provider' | 'text' | 'omit'
    // 启用交错思维 beta
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
    api: 'responses',  // Responses API 用于推理
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

这些 Provider 使用 OpenAI 兼容 API 并带有自定义推理字段：

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
      stripFromHistory: true,  // DeepSeek 必需
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

## 推理传输

`reasoningTransport` 选项控制思维内容在消息历史中的处理方式：

| 值 | 行为 | 使用场景 |
|----|------|----------|
| `'provider'` | 保持为原生 `reasoning` 块 | 完整思维保留，多轮连续性 |
| `'text'` | 包装在 `<think></think>` 标签中 | 跨 Provider 兼容性 |
| `'omit'` | 从历史中移除 | 节省 token，隐私保护 |

```typescript
// Provider 原生格式
const config = {
  reasoningTransport: 'provider',  // { type: 'reasoning', reasoning: '...' }
};

// 文本格式
const config = {
  reasoningTransport: 'text',  // { type: 'text', text: '<think>...</think>' }
};

// 从历史中省略
const config = {
  reasoningTransport: 'omit',  // 思维块被移除
};
```

---

## 交错思维

交错思维允许模型在工具调用之间进行思考，实现更复杂的推理：

```
用户: 搜索 X，然后总结
模型: <thinking> 让我先搜索 X... </thinking>
模型: [tool_use: search_tool]
[tool_result]
模型: <thinking> 得到结果了，现在我应该总结... </thinking>
模型: [tool_use: summarize_tool]
[tool_result]
模型: <thinking> 综合所有内容... </thinking>
模型: 这是总结...
```

### 启用交错思维

```typescript
// Anthropic 交错思维
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

## 思维事件

当 `exposeThinking: true` 时，思维事件会发送到 Progress 通道：

```typescript
for await (const envelope of agent.subscribe(['progress'])) {
  switch (envelope.event.type) {
    case 'think_chunk_start':
      // 思维块开始
      console.log('[思考中...]');
      break;

    case 'think_chunk':
      // 思维内容增量
      process.stdout.write(envelope.event.delta);
      break;

    case 'think_chunk_end':
      // 思维块结束
      console.log('[/思考]');
      break;

    case 'tool:start':
      console.log(`[工具: ${envelope.event.call.name}]`);
      break;

    case 'text_chunk':
      process.stdout.write(envelope.event.delta);
      break;

    case 'done':
      break;
  }
}
```

### 事件序列

典型的交错思维序列：

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

通过 `CompletionOptions.thinking` 配置思维：

```typescript
interface ThinkingOptions {
  enabled?: boolean;          // 启用思维模式
  budgetTokens?: number;      // Token 预算（Anthropic, Gemini 2.5）
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';  // OpenAI
  level?: 'minimal' | 'low' | 'medium' | 'high';  // Gemini 3.x
}
```

---

## 最佳实践

### 1. 选择适当的预算

更高的预算 = 更深入的思考，但更慢且更昂贵：

```typescript
// 快速任务：较低预算
const quickThinking = { type: 'enabled', budget_tokens: 2000 };

// 复杂推理：较高预算
const deepThinking = { type: 'enabled', budget_tokens: 16000 };
```

### 2. 多轮推理使用 `retainThinking`

对于需要推理连续性的对话：

```typescript
const agent = await Agent.create({
  templateId: 'analyst',
  exposeThinking: true,
  retainThinking: true,  // 保留推理以提供上下文
}, deps);
```

### 3. 剥离思维以节省 Token

如果思维仅用于单轮且不需要保留在历史中：

```typescript
const provider = new AnthropicProvider(apiKey, model, undefined, undefined, {
  reasoningTransport: 'omit',  // 不持久化思维
  extraBody: {
    thinking: { type: 'enabled', budget_tokens: 5000 },
  },
});

const agent = await Agent.create({
  templateId: 'solver',
  exposeThinking: true,   // 向用户展示思维
  retainThinking: false,  // 不持久化
}, deps);
```

### 4. 提示交错思维

鼓励模型在步骤之间进行思考：

```typescript
const prompt = `
我需要分析这些数据。请：
1. 首先，使用 fetch_data 工具获取数据
2. 思考你观察到的模式
3. 使用 analyze_tool 运行分析
4. 思考其含义
5. 提供你的结论

在每个步骤之间仔细思考。
`;

await agent.send(prompt);
```

---

## 完整示例

```typescript
import {
  Agent,
  AnthropicProvider,
  JSONStore,
  defineTool,
} from '@shareai-lab/kode-sdk';

// 定义工具
const searchTool = defineTool({
  name: 'search',
  description: '搜索信息',
  params: {
    query: { type: 'string', description: '搜索查询' }
  },
  async exec(args) {
    return { results: `关于 ${args.query} 的结果` };
  }
});

async function reasoningAgent() {
  // 配置带扩展思维的 provider
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

  // 创建启用思维的 agent
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

  // 监听进度事件
  const progressTask = (async () => {
    for await (const envelope of agent.subscribe(['progress'])) {
      const event = envelope.event;

      if (event.type === 'think_chunk_start') {
        process.stdout.write('\n[思考] ');
      } else if (event.type === 'think_chunk') {
        process.stdout.write(event.delta);
      } else if (event.type === 'think_chunk_end') {
        process.stdout.write(' [/思考]\n');
      } else if (event.type === 'tool:start') {
        console.log(`\n[工具: ${event.call.name}]`);
      } else if (event.type === 'text_chunk') {
        process.stdout.write(event.delta);
      } else if (event.type === 'done') {
        break;
      }
    }
  })();

  // 发送需要推理的任务
  await agent.send(`
    使用 search 工具研究"机器学习趋势"，
    然后提供深入的分析。逐步思考。
  `);

  await progressTask;
}
```

---

## 故障排查

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 无思维事件 | `exposeThinking: false` | 设置 `exposeThinking: true` |
| 思维未保留 | `retainThinking: false` | 设置 `retainThinking: true` |
| 思维从历史中剥离 | `reasoningTransport: 'omit'` | 使用 `'provider'` 或 `'text'` |
| 工具无交错 | Beta 未启用 | 启用 `beta.interleavedThinking` |
| "Thinking signature invalid" 错误 | 修改了思维块 | 不要修改推理内容 |

---

## 参考资料

- [Provider 指南](./providers.md) - Provider 特定的思维配置
- [事件指南](./events.md) - Progress 事件处理
- [工具指南](./tools.md) - 工具集成
- [API 参考](../reference/api.md) - ThinkingOptions 接口
