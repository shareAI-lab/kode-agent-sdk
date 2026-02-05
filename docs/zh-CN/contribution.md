# 贡献指南

感谢你为 KODE SDK 做出贡献。本指南说明提交 PR 的要求与流程。

## 范围
- 代码改动
- 文档改动
- 示例改动
- 测试改动
- 发布相关改动

## 开始之前
- 先检索已有 issue 和文档，避免重复工作。
- 涉及大功能或行为变更，建议先发起 issue 或讨论。
- 单个 PR 只做一件事，避免混合无关改动。

## 分支策略
- 从 `main` 分支拉取并创建新分支。
- 分支名建议: `feat/<short-desc>`、`fix/<short-desc>`、`docs/<short-desc>`。

## PR 描述
- 必须包含: 目的、改动范围、影响/兼容性、测试结果。
- 建议包含: 相关 issue / 需求链接、截图或日志（如适用）。

## 改动范围
- 避免在一个 PR 中混合不相关改动。
- 避免无关格式化或大规模重排，除非必要且说明原因。

## 代码质量
- 与改动相关的测试必须通过。
- 新增功能必须补测试或说明原因。
- 避免明显性能回退与安全风险。
- 遵循现有 TypeScript 风格、模块边界与公共 API 稳定性。

## 依赖与构建产物
- 一个 PR 只使用一种包管理工具，并只更新对应锁文件: `package-lock.json` 或 `pnpm-lock.yaml`。
- 不提交 `dist/` 等构建产物，除非发布或维护者要求。

## 破坏性变更
- 原则上避免破坏性变更。
- 若不可避免，必须在 PR 标题或描述标注 `BREAKING`，并提交详细说明报告。
- 需提供过渡方案，例如兼容层、弃用期与迁移步骤。
- 说明报告建议包含: 影响范围、迁移步骤、过渡期策略、风险与回滚方案。

## 测试（必需）
- `npm run test:unit` 必须通过。
- 涉及 DB、provider、sandbox 或跨模块流程时，需运行 `test:integration` 或 `test:e2e`。
- 新功能至少提供单元测试；必要时补集成或端到端测试。

## 测试格式
- 测试文件放置于 `tests/unit`、`tests/integration` 或 `tests/e2e`。
- 文件命名使用 `*.test.ts`。
- 使用 `tests/helpers/utils.ts` 中的 `TestRunner` 与 `expect`。
- 需要时使用 `tests/helpers/setup.ts` 中的 `createUnitTestAgent` 与 `createIntegrationTestAgent`。
- 每个测试文件导出 `export async function run() { ... }`。
- 复杂流程可使用 `tests/helpers/integration-harness.ts`。
- 以 `../../tests/README.md` 为规范参考。

## 测试设计要求
- 覆盖正常路径、关键边界与失败路径。
- 新增功能至少覆盖核心行为与关键边界场景。
- 单元测试避免依赖真实 API/网络，真实模型测试放在集成或端到端。
- 断言需可验证结果或副作用（返回状态、事件、持久化结果等）。
- 使用 `cleanup` 等机制清理临时目录与资源。
- 避免不稳定因素（随机性、时间依赖）；必要时固定输入或 mock。

## 测试范例
单元测试示例（来自 `tests/unit/utils/agent-id.test.ts`）:
```ts
import { generateAgentId } from '../../../src/utils/agent-id';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('AgentId');

// Crockford Base32 字符集（用于时间戳编码）
const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

runner
  .test('生成的AgentId唯一且包含时间戳', async () => {
    const id1 = generateAgentId();
    const id2 = generateAgentId();

    // 验证唯一性
    expect.toEqual(id1 !== id2, true);

    // 验证格式：agt-{时间戳10位}{随机16位}
    expect.toContain(id1, 'agt-');
    expect.toEqual(id1.length, 4 + 10 + 16); // agt- + 时间戳 + 随机

    // 验证时间戳部分（前10位）是有效的 Crockford Base32
    const timePart = id1.slice(4, 14);
    for (const char of timePart) {
      expect.toEqual(
        CROCKFORD32.includes(char),
        true,
        `时间戳字符 '${char}' 不是有效的 Crockford Base32`
      );
    }
  });

export async function run() {
  return await runner.run();
}
```

集成测试示例（来自 `tests/integration/features/events.test.ts`）:
```ts
import { collectEvents } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';

const runner = new TestRunner('集成测试 - 事件系统');

runner.test('订阅 progress 与 monitor 事件', async () => {
  console.log('\n[事件测试] 测试目标:');
  console.log('  1) 验证 progress 流中包含 text_chunk 与 done 事件');
  console.log('  2) 验证 monitor 信道会广播 state_changed');

  const harness = await IntegrationHarness.create();

  const monitorEventsPromise = collectEvents(harness.getAgent(), ['monitor'], (event) => event.type === 'state_changed');

  const { events } = await harness.chatStep({
    label: '事件测试',
    prompt: '请简单自我介绍',
  });

  const progressTypes = events
    .filter((entry) => entry.channel === 'progress')
    .map((entry) => entry.event.type);

  expect.toBeGreaterThan(progressTypes.length, 0);
  expect.toBeTruthy(progressTypes.includes('text_chunk'));
  expect.toBeTruthy(progressTypes.includes('done'));

  const monitorEvents = await monitorEventsPromise;
  expect.toBeGreaterThan(monitorEvents.length, 0);

  await harness.cleanup();
});

export async function run() {
  return runner.run();
}
```

端到端测试示例（来自 `tests/e2e/scenarios/long-run.test.ts`）:
```ts
import path from 'path';
import fs from 'fs';
import { createUnitTestAgent, collectEvents } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('E2E - 长时运行流程');

runner
  .test('Todo、事件与快照协同工作', async () => {
    const { agent, cleanup, storeDir } = await createUnitTestAgent({
      enableTodo: true,
      mockResponses: ['First turn', 'Second turn', 'Final response'],
    });

    const monitorEventsPromise = collectEvents(agent, ['monitor'], (event) => event.type === 'todo_reminder');

    await agent.setTodos([{ id: 't1', title: '撰写测试', status: 'pending' }]);
    await agent.chat('开始任务');
    await agent.chat('继续执行');

    const todos = agent.getTodos();
    expect.toEqual(todos.length, 1);

    const reminderEvents = await monitorEventsPromise;
    expect.toBeGreaterThan(reminderEvents.length, 0);

    await agent.updateTodo({ id: 't1', title: '撰写测试', status: 'completed' });
    await agent.deleteTodo('t1');

    const snapshotId = await agent.snapshot();
    expect.toBeTruthy(snapshotId);

    const snapshotPath = path.join(storeDir, agent.agentId, 'snapshots', `${snapshotId}.json`);
    expect.toEqual(fs.existsSync(snapshotPath), true);

    await cleanup();
  });

export async function run() {
  return await runner.run();
}
```

## 文档与示例
- 用户可见变更需更新`docs`。
- 保持 `docs/en` 与 `docs/zh-CN` 同步。
- 行为或 API 变更需更新示例。
- 若无法同步文档，需说明原因并给出补齐计划。

## 文档格式
- 使用 Markdown，顶部单一 `#` 标题，正文按 `##` / `###` 分级且不跳级。
- 代码块必须标注语言（如 `ts`、`bash`、`json`）。
- 项目内文档使用相对路径链接。
- 公共 API 引用需与 `src/index.ts` 导出一致。
- 新增文档需在 README 文档表格中加入入口。

## 提交信息
- 不强制格式，但必须清楚描述变更内容。

## PR 模板
- 使用 `.github/pull_request_template.md`。

## 审查
- 至少 1 位维护者批准后合并。
- 高风险改动建议增加 reviewer。

## 变更记录
- 暂不维护 `CHANGELOG`。
- 变更记录以 `git log` 为准。
- 版本号由维护者统一处理。

## 安全与许可证
- 禁止提交密钥、token 或私有数据。
- 新增依赖需说明原因并确保许可证兼容。

## DCO / CLA
- 暂不要求 DCO 或 CLA。
