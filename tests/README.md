# KODE SDK 测试套件

测试体系由 **单元测试 → 集成测试 → 端到端场景** 三层构成，确保 SDK 对外能力（Agent 生命周期、事件播报、权限审批、Hook 拦截、Sandbox 边界、内置工具、Todo 流程等）覆盖常见使用路径并提供回归保障；通过测试不代表所有环境都没有问题。

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

### 离线上手回归

```bash
npm run test:quickstart   # Node 内置运行器；不需要 npm 依赖，不执行真实安装
npm run test:onboarding   # 先构建，用 mock provider 检查公开 API 与入门示例
npm run test:package      # 本地打包并离线安装到全新临时项目，检查 CJS/ESM、声明与完整示例；不发布
npm run test:package -- --native # 另运行消费者原生安装脚本及 SQLite 健康/关闭检查；CI 使用
npm run typecheck:examples
```

默认打包检查禁用依赖安装脚本，要求依赖 tarball 已在 npm 缓存中。`--native` 保留离线 npm 依赖解析，但原生安装子脚本可能联网下载预编译二进制或构建所需文件；它不代表完全离线或完整平台矩阵。CI 先运行正常 `npm ci`，再验证全新 tarball 消费者。

`npm test` / `test:unit` 先构建，默认不加载 `.env.test`，并明确跳过依赖外部数据库的 PostgreSQL 套件。需要 PostgreSQL 回归时，在已配置测试数据库的环境中设置 `KODE_TEST_POSTGRES=1` 再运行；CI 单元测试任务已启用。不要把数据库不可用时跳过的用例视为实际通过。`test:onboarding` 禁止真实 fetch，覆盖首次/连续请求、事件过滤、并发消费、审批允许/拒绝与应用截止期限、中断、工具并发与参数、受控 HTTP/SSE 错误、真实子进程崩溃恢复、文件路径/符号链接边界和错误返回，不读取模型密钥。

### 集成测试配置

集成测试会直接调用真实模型 API，请在项目根目录创建 `.env.test`（可参考 `.env.test.example`）：

```ini
ANTHROPIC_API_KEY=sk-...
ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514  # 可选，默认 claude-sonnet-4-20250514
ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选，默认 https://api.anthropic.com
```

缺少 `ANTHROPIC_API_KEY` 时，集成测试将提示创建方式并终止。

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
