# KODE SDK 测试套件

测试体系由 **单元测试 → 集成测试 → 端到端场景** 三层构成，确保 SDK 对外能力（Agent 生命周期、事件播报、权限审批、Hook 拦截、Sandbox 边界、内置工具、Todo 流程等）具备生产级覆盖与回归保障。

## 目录概览

```
tests/
├── helpers/            # 固件、环境构造、断言工具
│   ├── fixtures.ts     # 模板、集成配置加载
│   ├── setup.ts        # createUnitTestAgent / createIntegrationTestAgent
│   └── utils.ts        # TestRunner / expect / util 函数
├── unit/               # 核心、基础设施、工具的单元测试
│   ├── core/*.test.ts
│   ├── infra/*.test.ts
│   └── tools/*.test.ts
├── integration/        # 真实模型 API 流程测试
│   └── agent/*.test.ts, tools/*.test.ts
├── e2e/                # 端到端场景化测试（长运行、权限 Hook）
├── run-unit.ts         # 单元测试入口
├── run-integration.ts  # 集成测试入口
├── run-e2e.ts          # 端到端测试入口
└── run-all.ts          # 串行执行全部测试
```

## 运行方式

```bash
npm test            # 或 npm run test:unit
npm run test:e2e
npm run test:integration
npm run test:all
```

> 在执行集成 / 端到端测试前，请确认 `.env.test` 已配置真实模型 API 信息，并确保网络可访问该模型服务。

### 集成测试配置

集成测试会直接调用真实模型 API，请在项目根目录创建 `.env.test`：

```ini
KODE_SDK_TEST_PROVIDER_BASE_URL=https://api.moonshot.cn/anthropic
KODE_SDK_TEST_PROVIDER_API_KEY=<your-api-key>
KODE_SDK_TEST_PROVIDER_MODEL=kimi-k2-turbo-preview
```

如需放置在其它位置，可通过环境变量 `KODE_SDK_TEST_ENV_PATH` 指向该文件。缺少配置时，集成测试将提示创建方式并终止。

### 集成测试支撑工具

- `IntegrationHarness`：位于 `tests/helpers/integration-harness.ts`，封装了 agent 创建、事件追踪、Resume、子代理委派等操作，可在测试用例中输出详细的流程日志。
- `chatStep / delegateTask / resume`：统一打印用户指令、模型响应、事件流，辅助定位真实 API 行为。

## 示例：单元测试

```ts
import { createUnitTestAgent } from '../helpers/setup';
import { TestRunner, expect } from '../helpers/utils';

const runner = new TestRunner('Agent 核心能力');

runner.test('单轮对话', async () => {
  const { agent, cleanup } = await createUnitTestAgent({
    mockResponses: ['Hello Unit Test'],
  });

  const result = await agent.chat('Hi');
  expect.toEqual(result.status, 'ok');
  expect.toContain(result.text!, 'Hello Unit Test');

  await cleanup();
});

export async function run() {
  return runner.run();
}
```

## 示例：集成测试

```ts
import { createIntegrationTestAgent } from '../helpers/setup';
import { TestRunner, expect } from '../helpers/utils';

const runner = new TestRunner('真实模型对话');

runner.test('多轮会话', async () => {
  const { agent, cleanup } = await createIntegrationTestAgent();

  const reply = await agent.chat('请用一句话介绍自己');
  expect.toBeTruthy(reply.text);

  await cleanup();
});

export async function run() {
  return runner.run();
}
```

## 覆盖范围速览

### 单元测试
- Agent 生命周期：创建 / 对话 / 流式 / 快照 / Fork / Resume / 中断
- 事件系统：多通道订阅、历史回放、持久化失败重试
- Hook 与权限：链式 Hook、结果替换、权限模式注册与序列化
- Todo：服务层校验、提醒策略、管理器事件
- Scheduler & TimeBridge、MessageQueue、ContextManager、FilePool
- 基础设施：JSONStore WAL、LocalSandbox 边界与危险命令拦截
- 内置工具：文件、Bash、Todo 工具执行
- 其他：ToolRunner、AgentId 等辅助模块

### 集成测试
- 真实模型多轮对话与流式输出
- Agent Resume 恢复流程
- 真实 Sandbox 中文件工具读写与编辑

### 端到端场景
- 长时运行：Todo → 事件 → 快照 全链路验证
- 权限 & Hook：审批决策 + Hook 拦截 + Sandbox 写入安全

## 辅助工具

- `createUnitTestAgent / createIntegrationTestAgent`：快速获取预配置 Agent（MockProvider / 真实模型）
- `collectEvents`：订阅并收集事件直到命中条件
- `TestRunner` + `expect`：轻量级测试注册与断言 API

欢迎根据业务场景继续补充测试用例，保持 SDK 能力的高覆盖与高可靠性。
