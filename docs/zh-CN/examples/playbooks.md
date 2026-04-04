# Playbooks：典型场景脚本

本页从实践角度拆解最常见的使用场景，给出心智地图、关键 API、示例文件以及注意事项。示例代码位于 `examples/` 目录，可直接 `ts-node` 运行。

---

## 1. 协作收件箱（事件驱动 UI）

- **目标**：持续运行的单 Agent，UI 通过 Progress 流展示文本/工具进度，Monitor 做轻量告警。
- **示例**：`examples/01-agent-inbox.ts`
- **运行**：`npm run example:agent-inbox`
- **关键步骤**：
  1. `Agent.create` + `agent.subscribe(['progress'])` 推送文本增量。
  2. 使用 `bookmark` / `cursor` 做断点续播。
  3. `agent.on('tool_executed')` / `agent.on('error')` 将治理事件写入日志或监控。
  4. `agent.todoManager` 自动提醒，UI 可展示 Todo 面板。
- **注意事项**：
  - 建议将 Progress 流通过 SSE/WebSocket 暴露给前端。
  - 若 UI 需要思考过程，可在模板 metadata 中开启 `exposeThinking`。

```typescript
// 基本事件订阅
for await (const envelope of agent.subscribe(['progress'])) {
  if (envelope.event.type === 'text_chunk') {
    process.stdout.write(envelope.event.delta);
  }
  if (envelope.event.type === 'done') {
    break;
  }
}
```

---

## 2. 工具审批 & 治理

- **目标**：对敏感工具（如 `bash_run`、数据库写入）进行审批；结合 Hook 实现策略守卫。
- **示例**：`examples/02-approval-control.ts`
- **运行**：`npm run example:approval`
- **关键步骤**：
  1. 模板中配置 `permission`（如 `mode: 'approval'` + `requireApprovalTools`）。
  2. 订阅 `agent.on('permission_required')`，将审批任务推送到业务系统。
  3. 审批 UI 调用 `agent.decide(id, 'allow' | 'deny', note)`。
  4. 结合 `HookManager` 的 `preToolUse` / `postToolUse` 做更细粒度的策略（如路径守卫、结果截断）。
- **注意事项**：
  - 审批过程中 Agent 处于 `AWAITING_APPROVAL` 断点，恢复后 SDK 自动处理。
  - 拒绝工具会自动写入 `tool_result`，UI 可以提示用户重试策略。

```typescript
// 权限配置
const template = {
  id: 'secure-runner',
  permission: {
    mode: 'approval',
    requireApprovalTools: ['bash_run'],
  },
  // Hook 做额外守卫
  hooks: {
    preToolUse(call) {
      if (call.name === 'bash_run' && /rm -rf|sudo/.test(call.args.cmd)) {
        return { decision: 'deny', reason: '命令命中禁用关键字' };
      }
    },
  },
};

// 审批处理
agent.on('permission_required', async (event) => {
  const decision = await getApprovalFromAdmin(event.call);
  await event.respond(decision, { note: '管理员批准' });
});
```

---

## 3. 多 Agent 小组协作

- **目标**：一个 Planner 调度多个 Specialist，所有 Agent 长驻且可随时分叉。
- **示例**：`examples/03-room-collab.ts`
- **运行**：`npm run example:room`
- **关键步骤**：
  1. 使用单例 `AgentPool` 管理 Agent 生命周期（`create` / `resume` / `fork`）。
  2. 通过 `Room` 实现广播/点名消息；消息带 `[from:name]` 模式进行协作。
  3. 子 Agent 通过 `task_run` 工具或显式 `pool.create` 拉起。
  4. 利用 `agent.snapshot()` + `agent.fork()` 在 Safe-Fork-Point 分叉出新任务。
- **注意事项**：
  - 模板的 `runtime.subagents` 可限制可分派模板与深度。
  - 需要持久化 lineage（SDK 默认写入 metadata），便于审计和回放。
  - 如果不监控外部文件，可在模板中关闭 `watchFiles`。

```typescript
const pool = new AgentPool({ dependencies: deps, maxAgents: 10 });
const room = new Room(pool);

const planner = await pool.create('agt-planner', { templateId: 'planner', ... });
const dev = await pool.create('agt-dev', { templateId: 'executor', ... });

room.join('planner', planner.agentId);
room.join('dev', dev.agentId);

// 广播到 Room
await room.say('planner', 'Hi team, let us audit the repository. @dev 请负责执行。');
await room.say('dev', '收到，开始处理。');
```

---

## 4. 调度与系统提醒

- **目标**：让 Agent 在长时运行中定期执行任务、监控文件变更、发送系统提醒。
- **示例**：`examples/04-scheduler-watch.ts`
- **运行**：`npm run example:scheduler`
- **关键步骤**：
  1. `const scheduler = agent.schedule(); scheduler.everySteps(N, callback)` 注册步数触发。
  2. 使用 `agent.remind(text, options)` 发送系统级提醒（走 Monitor，不污染 Progress）。
  3. FilePool 默认会监听写入文件，`monitor.file_changed` 触发后可结合 `scheduler.notifyExternalTrigger` 做自动响应。
  4. Todo 结合 `remindIntervalSteps` 做定期回顾。
- **注意事项**：
  - 调度任务应保持幂等，遵循事件驱动思想。
  - 对高频任务可结合外部 Cron，在触发时调用 `scheduler.notifyExternalTrigger`。

---

## 5. 数据库持久化

- **目标**：将 Agent 状态持久化到 SQLite 或 PostgreSQL，用于生产部署。
- **示例**：`examples/db-sqlite.ts`、`examples/db-postgres.ts`
- **关键步骤**：
  1. 使用 `createExtendedStore` 工厂函数创建 Store。
  2. 将 Store 传递给 Agent 依赖。
  3. 使用 Query API 进行会话管理和分析。

```typescript
import { createExtendedStore, SqliteStore } from '@shareai-lab/kode-sdk';

// 创建 SQLite Store
const store = createExtendedStore({
  type: 'sqlite',
  dbPath: './data/agents.db',
  fileStoreBaseDir: './data/files',
}) as SqliteStore;

// 与 Agent 一起使用
const agent = await Agent.create(
  { templateId: 'my-agent', ... },
  { store, ... }
);

// Query API
const sessions = await store.querySessions({ limit: 10 });
const stats = await store.aggregateStats(agent.agentId);
```

---

## 6. 观测层读取与应用层 HTTP 包装

- **目标**：从 SDK 读取运行时/持久化 observation，并按你自己的应用边界选择是否通过 HTTP 暴露出去。
- **示例**：`examples/08-observability-http.ts`
- **运行**：`npm run example:observability-http`
- **关键步骤**：
  1. 通过 `agent.getMetricsSnapshot()` 读取当前指标快照。
  2. 通过 `agent.getObservationReader()` 或 `agent.subscribeObservations()` 读取运行时 observation。
  3. 为 `observability.persistence.backend` 配置后端，并用 `createStoreBackedObservationReader(...)` 查询历史数据。
  4. 在应用代码中自行定义路由、鉴权、租户隔离和响应裁剪。
- **注意事项**：
  - 运行时 reader 更适合“现在发生了什么”，持久化 reader 更适合审计与历史视图。
  - `metadata.__debug` 只能视为内部调试数据，不应直接原样对外暴露。
  - HTTP、鉴权、限流、Dashboard 都应留在 SDK 外部。

```typescript
const metrics = agent.getMetricsSnapshot();
const runtimeReader = agent.getObservationReader();
const persistedReader = createStoreBackedObservationReader(observationBackend);

const runtime = runtimeReader.listObservations({ limit: 20 });
const persisted = await persistedReader.listObservations({ agentIds: [agent.agentId], limit: 50 });
```

---

## 7. 组合拳：审批 + 协作 + 调度

- **场景**：代码审查机器人，Planner 负责拆分任务并分配到不同 Specialist，工具操作需审批，定时提醒确保 SLA。
- **实现路径**：
  1. **Planner 模板**：具备 `task_run` 工具与调度 Hook，每日早晨自动巡检。
  2. **Specialist 模板**：聚焦 `fs_*` + `todo_*` 工具，审批策略只对 `bash_run` 开启。
  3. **统一审批服务**：监听全部 Agent 的 Control 事件，打通企业 IM / 审批流。
  4. **Room 协作**：Planner 将任务以 `@executor` 形式投递，执行完成再 @planner 汇报。
  5. **SLA 监控**：Monitor 事件进入 observability pipeline（Prometheus / ELK / Datadog）。
  6. **调度提醒**：使用 Scheduler 定期检查待办或外部系统信号。

---

## 常用组合 API 速查

| 分类 | API |
|------|-----|
| 事件 | `agent.subscribe(['progress'])`、`agent.on('error', handler)`、`agent.on('tool_executed', handler)` |
| 审批 | `permission_required` → `event.respond()` / `agent.decide()` |
| 多 Agent | `new AgentPool({ dependencies, maxAgents })`、`const room = new Room(pool)` |
| 分叉 | `const snapshot = await agent.snapshot(); const fork = await agent.fork(snapshot);` |
| 调度 | `agent.schedule().everySteps(10, ...)`、`scheduler.notifyExternalTrigger(...)` |
| Todo | `agent.getTodos()` / `agent.setTodos()` / `todo_read` / `todo_write` |
| 数据库 | `createExtendedStore({ type: 'sqlite', ... })`、`store.querySessions()` |

---

## 参考资料

- [快速开始](../getting-started/quickstart.md)
- [事件指南](../guides/events.md)
- [可观测性指南](../guides/observability.md)
- [多 Agent 系统](../advanced/multi-agent.md)
- [数据库指南](../guides/database.md)
