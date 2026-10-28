# 快速开始

先在仓库根目录运行离线示例：

```bash
npm ci
npm run build
npm run example:getting-started -- --mock
```

在自己的 npm 项目中，先按[安装说明](./installation.md)配置环境，将完整示例保存为 `getting-started.ts`，再运行 `npx ts-node getting-started.ts`。提前设置 `ANTHROPIC_API_KEY`；该路径调用真实模型，上面的 mock 命令不会。

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

## 发送与事件消费

`chatStream()` 发送一条输入并消费到本轮结束，迭代完成或调用方 `break` 时释放订阅。`chat()` 返回最终回复。模型执行失败时，两者抛错。即使 `kinds` 过滤掉输出中的 `done`，迭代器仍会结束。

`send()` 仅入队并返回消息 ID，不等待回复；原始订阅需要并发消费：

```typescript
const progress = (async () => {
  for await (const { event } of agent.subscribe(['progress'])) {
    if (event.type === 'text_chunk') process.stdout.write(event.delta);
    if (event.type === 'done') break;
  }
})();
await agent.send('Hello!');
await progress;
```

同一 Agent 同时只接受一个 `chat()` / `chatStream()`；重叠调用会在输入入队前拒绝，需先等待当前轮结束。完成事件描述轮次，未按消息 ID 隔离。应用消息队列可用 `send()` 配合一个长期消费者。

## 审批、中断与恢复

模板需要审批时，先注册 `permission_required` 再发送。等待审批期间 `chat()` 保持 pending，不会立即返回 `paused`。通过 `event.respond('allow' | 'deny')` 或 `agent.decide(callId, decision)` 决策，每次审批只能回复一次，详见[事件指南](../guides/events.md)。

`await agent.interrupt()` 取消等待队列中的工具、拒绝未决审批，并向运行中的工具发出取消信号。复用 Agent 或释放 sandbox 前，仍需消费终止 `done` 或等待当前 chat 任务结束。Provider 的取消依赖配合：阻塞等待网络数据的 Provider 可能要到下一次产出时才会停止。中断不能撤销工具已经发生的副作用。

保存 `agent.agentId`。重新创建依赖并注册相同模板/工具，调用 `Agent.resumeFromStore(id, deps, { autoRun: false, strategy: 'crash' })`，重新绑定回调，再发送下一条消息，详见[恢复与分叉](../guides/resume-fork.md)。

LocalSandbox 的文件 API 会按工作目录和 allowPaths 检查路径及符号链接目标；开启边界检查时 glob 不遍历目录符号链接。shell 命令仍使用宿主用户权限，因此 LocalSandbox 不提供不可信代码的操作系统隔离，路径检查也不能消除并发文件系统竞态。需要这种隔离时，应使用独立隔离的 sandbox。

## 资源归属

文件监听结合原生通知和 250 ms 的 stat 检查，以覆盖漏通知及原生 watcher 资源耗尽的情况。多次变化可能合并，不能用它代替审计日志。调用 `unwatchFiles(id)` 或释放所属 sandbox 时，两种机制都会停止。

示例自行持有 `LocalSandbox`，并在 `finally` 中释放。应用创建的 TimeBridge 定时器需调用 `dispose()`，调度任务可通过 `agent.schedule().clear()` 清理；调用 `on()` 返回的退订函数，并关闭保留的原始订阅。应用创建 MCP 客户端后可用 `disconnectAllMCP()` 释放。数据库 Store 应在所有 Agent 和事件写入完成后 `await store.close()`。其他 Agent 仍在使用时，不要关闭共享 sandbox 或 store。

## 下一步

- [核心概念](./concepts.md)
- [事件指南](../guides/events.md)
- [工具指南](../guides/tools.md)
- [数据库指南](../guides/database.md)
