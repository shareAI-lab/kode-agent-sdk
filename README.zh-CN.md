# KODE SDK

[English](./README.md) | [中文](./README.zh-CN.md)

> 事件驱动的长时运行 AI Agent 框架，支持企业级持久化和多 Agent 协作。

## 核心特性

- **事件驱动架构** - 三通道系统 (Progress/Control/Monitor) 清晰分离关注点
- **长时运行与恢复** - 七段断点机制，支持 Safe-Fork-Point 崩溃恢复
- **多 Agent 协作** - AgentPool、Room 消息、任务委派
- **企业级持久化** - 支持 SQLite/PostgreSQL，统一 WAL 日志
- **云端沙箱** - 集成 [E2B](https://e2b.dev)，提供隔离的远程代码执行环境
- **可扩展生态** - MCP 工具、自定义 Provider、Skills 系统

## 快速开始

**一键启动**（安装依赖并构建）：

```bash
./quickstart.sh
```

或作为依赖安装：

```bash
npm install @shareai-lab/kode-sdk
```

设置环境变量：

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export ANTHROPIC_API_KEY=sk-...
export ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514  # 可选，默认: claude-sonnet-4-20250514
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选，默认: https://api.anthropic.com
```

#### **Windows (PowerShell)**
```powershell
$env:ANTHROPIC_API_KEY="sk-..."
$env:ANTHROPIC_MODEL_ID="claude-sonnet-4-20250514"  # 可选，默认: claude-sonnet-4-20250514
$env:ANTHROPIC_BASE_URL="https://api.anthropic.com"  # 可选，默认: https://api.anthropic.com
```
<!-- tabs:end -->

最简示例：

```typescript
import { Agent, AnthropicProvider, JSONStore } from '@shareai-lab/kode-sdk';

const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  process.env.ANTHROPIC_MODEL_ID
);

const agent = await Agent.create({
  provider,
  store: new JSONStore('./.kode'),
  systemPrompt: '你是一个乐于助人的助手。'
});

// 订阅 progress 事件
for await (const envelope of agent.subscribe(['progress'])) {
  if (envelope.event.type === 'text_chunk') {
    process.stdout.write(envelope.event.delta);
  }
  if (envelope.event.type === 'done') break;
}

await agent.send('你好！');
```

运行示例：

```bash
npm run example:getting-started    # 最简对话
npm run example:agent-inbox        # 事件驱动收件箱
npm run example:approval           # 工具审批流程
npm run example:room               # 多Agent协作
```

## 支持的 Provider

| Provider | 流式输出 | 工具调用 | 推理 | 文件 |
|----------|---------|---------|------|------|
| Anthropic | ✅ | ✅ | ✅ Extended Thinking | ✅ |
| OpenAI | ✅ | ✅ | ✅ | ✅ |
| Gemini | ✅ | ✅ | ✅ | ✅ |

> **说明**：OpenAI 兼容的服务（DeepSeek、GLM、Qwen、Minimax、OpenRouter 等）可以通过 `OpenAIProvider` 配置自定义 `baseURL` 来使用。详见 [Provider 配置指南](./docs/zh-CN/guides/providers.md)。

## 文档

| 章节 | 说明 |
|------|------|
| **入门指南** | |
| [安装配置](./docs/zh-CN/getting-started/installation.md) | 环境配置与安装 |
| [快速上手](./docs/zh-CN/getting-started/quickstart.md) | 创建第一个 Agent |
| [核心概念](./docs/zh-CN/getting-started/concepts.md) | 核心概念详解 |
| **使用指南** | |
| [事件系统](./docs/zh-CN/guides/events.md) | 三通道事件系统 |
| [工具系统](./docs/zh-CN/guides/tools.md) | 内置工具与自定义工具 |
| [Skills 系统](./docs/zh-CN/guides/skills.md) | Skills 可复用提示词系统 |
| [Provider 配置](./docs/zh-CN/guides/providers.md) | 模型 Provider 配置 |
| [数据库存储](./docs/zh-CN/guides/database.md) | SQLite/PostgreSQL 持久化 |
| [恢复与分叉](./docs/zh-CN/guides/resume-fork.md) | 崩溃恢复与分支 |
| **参考** | |
| [API 参考](./docs/zh-CN/reference/api.md) | 完整 API 文档 |
| [示例集](./docs/zh-CN/examples/playbooks.md) | 所有示例详解 |

## 许可证

MIT
