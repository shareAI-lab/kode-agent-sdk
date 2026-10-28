# KODE SDK

[English](./README.md) | [中文](./README.zh-CN.md)

> 事件驱动的长时运行 AI Agent 框架，支持企业级持久化和多 Agent 协作。

## 核心特性

- **事件驱动架构** - 三通道系统 (Progress/Control/Monitor) 清晰分离关注点
- **长时运行与恢复** - 七段断点机制，支持 Safe-Fork-Point 崩溃恢复
- **多 Agent 协作** - AgentPool、Room 消息、任务委派
- **企业级持久化** - 支持 SQLite/PostgreSQL，统一 WAL 日志
- **云端沙箱** - 集成 [E2B](https://e2b.dev) 与 OpenSandbox，提供隔离的远程代码执行环境
- **可扩展生态** - MCP 工具、自定义 Provider、Skills 系统

## 快速开始

当前 `main` 包含下文说明的尚未发布的生命周期修复。截至 2026-10-25，npm `latest` 为 2.7.5，尚未包含本轮修改。请用源码 checkout 验收这些修复，不能将 npm 安装成功视为当前源码已验证。

需要 **Node.js 20.18.1–20.x 或 22.x–25.x**，与当前原生 SQLite 依赖支持范围一致。按使用场景选择源码仓库或已发布的包。

### 在源码仓库运行

```bash
git clone https://github.com/shareAI-lab/kode-agent-sdk.git
cd kode-agent-sdk
npm ci
npm run build
npm run example:getting-started -- --mock
```

mock 模式离线运行，不需要凭据，输出固定回复。`./quickstart.sh` 在 checkout 中安装锁定依赖并构建，不发送模型请求。所有 `example:*` 命令均在仓库根目录运行。真实请求需要设置 `ANTHROPIC_API_KEY`，再去掉 `--mock` 运行。

### 在自己的项目使用 npm 包

```bash
npm install @shareai-lab/kode-sdk
npm install --save-dev typescript ts-node @types/node
```

将以下配置保存为 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "Node16",
    "moduleResolution": "node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

在终端设置自己的模型凭据；模型与地址由示例显式传给 Provider：

```bash
export ANTHROPIC_API_KEY=your-key
export ANTHROPIC_MODEL_ID=claude-sonnet-4-5-20250929  # 示例 ID，请选择账号实际可用的模型
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选
```

Windows PowerShell 使用 `$env:ANTHROPIC_API_KEY="your-key"`，其余变量同理。

将下面的完整代码保存为 `getting-started.ts`，运行 `npx ts-node getting-started.ts`。这会调用真实模型，可能产生使用费用。

<!-- runnable:getting-started -->
```typescript
import {
  Agent, AnthropicProvider, JSONStore, AgentTemplateRegistry,
  ToolRegistry, SandboxFactory, LocalSandbox,
} from '@shareai-lab/kode-sdk';

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY before running this example.');
  const provider = new AnthropicProvider(
    apiKey,
    process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-5-20250929',
    process.env.ANTHROPIC_BASE_URL
  );
  const templates = new AgentTemplateRegistry();
  templates.register({ id: 'assistant', systemPrompt: 'You are a helpful assistant.' });
  const sandbox = new LocalSandbox({ workDir: './workspace', enforceBoundary: true, watchFiles: false });
  try {
    const agent = await Agent.create(
      { templateId: 'assistant', model: provider, sandbox },
      {
        store: new JSONStore('./.kode'),
        templateRegistry: templates,
        toolRegistry: new ToolRegistry(),
        sandboxFactory: new SandboxFactory(),
        modelFactory: () => provider,
      }
    );
    for await (const { event } of agent.chatStream('Hello!')) {
      if (event.type === 'text_chunk') process.stdout.write(event.delta);
    }
    console.log();
  } finally {
    await sandbox.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

`Agent.create(config, deps)` 需要两个参数和已注册的模板。`chatStream(input)` 负责发送并消费一轮事件，遇到 `done` 结束，模型错误会使迭代器抛错。`send()` 仅将消息入队并返回消息 ID。同一 Agent 上重叠的 `chat()` / `chatStream()` 会在入队前拒绝，需等待当前轮结束后再调用。使用 `subscribe()` 时，应先并发启动消费者，再 `send()`，并等待消费任务；订阅需通过 `break` 或迭代器 `return()` 关闭。

应用持有 sandbox，并在 `finally` 中释放。需要审批的工具必须在发送前注册 Control 监听器，见[事件指南](docs/zh-CN/guides/events.md)。持久化支持 JSONStore、SQLite 和 PostgreSQL，见[数据库指南](docs/zh-CN/guides/database.md)。SQLite 使用原生依赖，Node/平台没有匹配的预编译二进制时需要本机构建工具。

```bash
npm run test:onboarding     # 离线公开 API 生命周期回归
npm run test:quickstart     # 离线安装脚本回归
npm run test:package        # 构建、本地打包，检查 CJS/ESM/类型和完整文档示例
npm run typecheck:examples  # 构建后运行
```

其他示例可能需要真实模型或外部服务：

```bash
npm run example:agent-inbox
npm run example:approval
npm run example:room
npm run example:opensandbox
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
| [E2B 沙箱](./docs/zh-CN/guides/e2b-sandbox.md) | E2B 云端沙箱接入 |
| [OpenSandbox 沙箱](./docs/zh-CN/guides/opensandbox-sandbox.md) | OpenSandbox 自托管沙箱接入 |
| [Skills 系统](./docs/zh-CN/guides/skills.md) | Skills 可复用提示词系统 |
| [Provider 配置](./docs/zh-CN/guides/providers.md) | 模型 Provider 配置 |
| [数据库存储](./docs/zh-CN/guides/database.md) | SQLite/PostgreSQL 持久化 |
| [恢复与分叉](./docs/zh-CN/guides/resume-fork.md) | 崩溃恢复与分支 |
| **项目** | |
| [贡献指南](./docs/zh-CN/contribution.md) | 提交 PR 的要求与流程 |
| **参考** | |
| [API 参考](./docs/zh-CN/reference/api.md) | 完整 API 文档 |
| [示例集](./docs/zh-CN/examples/playbooks.md) | 所有示例详解 |

## 许可证

MIT
