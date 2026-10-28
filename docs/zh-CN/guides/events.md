# 事件系统指南

KODE SDK 的核心理念是"默认只推必要事件，其余一律走回调"。为此我们将交互拆成三条独立通道：

```
Progress  → 数据面（UI 渲染）
Control   → 审批面（人工决策）
Monitor   → 治理面（审计/告警）
```

本指南梳理每条通道的事件类型、最佳实践与常见陷阱。

---

## Progress：数据面

Progress 负责所有对用户可见的数据流：文本增量、工具生命周期、最终完成信号。事件均按时间序列推送，可用 `cursor`/`bookmark` 做断点续播。

| 事件 | 说明 |
|------|------|
| `think_chunk_start / think_chunk / think_chunk_end` | 模型思考阶段（可通过模板 metadata 开启 `exposeThinking`）。|
| `text_chunk_start / text_chunk / text_chunk_end` | 文本增量与最终分段。|
| `tool:start / tool:error / tool:end` | 工具执行生命周期；`tool:end` 始终发送（即使失败）。|
| `done` | 当前轮处理完毕，包含 `bookmark { seq, timestamp }`。|

```typescript
for await (const envelope of agent.subscribe(['progress'], { since: lastBookmark })) {
  switch (envelope.event.type) {
    case 'text_chunk':
      ui.append(envelope.event.delta);
      break;
    case 'tool:start':
      ui.showToolSpinner(envelope.event.call);
      break;
    case 'tool:end':
      ui.hideToolSpinner(envelope.event.call);
      break;
    case 'done':
      lastBookmark = envelope.bookmark;
      break;
  }
}
```

**最佳实践**

- 使用 **SSE/WebSocket** 将 Progress 推送到前端。
- 保存 `bookmark` / `cursor`，断线后以 `since` 续播。
- UI 只负责展示；业务判断（审批、治理）放到 Control/Monitor 或 Hook。
- 需要展示"思考过程"时开启 `exposeThinking`，否则保持默认关闭降低噪音。

**常见陷阱**

- 忘记消费 `done` 导致前端等待下一个事件。
- 在 Progress 中做审批逻辑，使系统难以扩展。

---

开启 reasoning 后，模型可能将整个输出 token 预算用于思考而未生成最终文本。当前 Agent 仍会以 `done`、`reason: completed` 结束流，不会在该事件中暴露 Provider 的 `finish_reason: length`。应检查回复是否包含可用文本，并按模型配置输出预算；流结束本身不代表已生成答案。

## Control：审批面

审批没有 SDK 自动截止时间。应用可设置期限，到期后拒绝审批或中断当前轮；收到决定后应清理定时器，避免迟到回调重复决定已结束的审批。

先注册 Control 处理器再发送请求。审批会暂停正在运行的轮次；`chat()` 等待决策，不会立即返回 `paused`。通过 `event.respond()` 或 `agent.decide()` 回复一次。中断轮次会将未决审批按拒绝处理。单轮请求可用 `chatStream()` 统一处理发送、终止事件、模型错误和订阅释放；原始订阅需由应用处理完成和错误。


Control 专门处理"需要人类决策"的瞬间。事件数量极少但重要，通常会被持久化到审批系统。

| 事件 | 说明 |
|------|------|
| `permission_required` | 工具执行需审批，包含 `call` 快照与 `respond(decision, opts?)` 回调。|
| `permission_decided` | 审批结果广播，包含 `callId`、`decision`、`decidedBy`、`note`。|

```typescript
agent.on('permission_required', async (event) => {
  const ticketId = await approvalStore.create({
    agentId: agent.agentId,
    callId: event.call.id,
    tool: event.call.name,
    preview: event.call.inputPreview,
  });

  // 立即给一个默认回应，或等待 UI/审批流决定
  await event.respond('deny', { note: `Pending approval ticket ${ticketId}` });
});
```

**最佳实践**

- 审批策略可以结合模板 `permission.requireApprovalTools` + Hook `preToolUse` 一起使用。
- 如果审批需要用户决定，保存 `event.call.id`，稍后调用 `agent.decide(callId, 'allow' | 'deny', note)`。
- Resume 后务必重新绑定 Control 事件监听。

**常见陷阱**

- 忘记处理 `permission_required` 导致工具一直卡在 `AWAITING_APPROVAL`。
- 审批回调抛错：`agent.decide` 只能调用一次，重复调用会报 "Permission not pending"。

---

## Monitor：治理面

Monitor 面向平台治理、审计、告警。默认只在必要时推送，适合写入日志与指标系统。

| 事件 | 说明 |
|------|------|
| `state_changed` | Agent 状态切换（READY / WORKING / PAUSED）。|
| `tool_executed` | 工具执行完成，含耗时、审批、审计信息。|
| `error` | 分类错误（`phase: model/tool/system`），附详细上下文。|
| `todo_changed` / `todo_reminder` | Todo 生命周期事件。|
| `file_changed` | FilePool 观察到外部改动。|
| `context_compression` | 上下文压缩摘要与比率。|
| `agent_resumed` | Resume 完成，含自动封口列表。|
| `tool_manual_updated` | 工具说明书注入/刷新。|

```typescript
agent.on('tool_executed', (event) => {
  auditLogger.info({
    agentId: agent.agentId,
    tool: event.call.name,
    durationMs: event.call.durationMs,
    approval: event.call.approval,
  });
});

agent.on('error', (event) => {
  alerting.notify(`Agent ${agent.agentId} error`, {
    phase: event.phase,
    severity: event.severity,
    detail: event.detail,
  });
});
```

**最佳实践**

- 统一将 Monitor 事件发送到日志/监控平台，以便审计与 SLA 追踪。
- `file_changed` 发生时可以自动触发提醒或调度任务。
- `agent_resumed` 事件应写入审计日志，便于排查自动封口情况。

**常见陷阱**

- 直接把 Monitor 推给终端用户，造成噪音；应先在后端过滤。
- 忽略 `severity` 字段，导致严重错误与提示信息混在一起。

---

## subscribe vs on：何时用哪一个？

- `agent.subscribe([...])` → **有序事件流**，适合前端/SSE/WebSocket。支持 `{ since, kinds }` 过滤。返回 `AsyncIterable`，记得处理 `done` 并关闭连接。
- `agent.on(type, handler)` → **回调式监听**，适合后台逻辑（审批、审计、告警）。返回 `unsubscribe` 函数，Resume 后需要重新绑定。

```typescript
const stream = agent.subscribe(['progress', 'monitor']);
const iterator = stream[Symbol.asyncIterator]();

// 后台治理
const off = agent.on('tool_executed', handler);
// 在适当时机调用 off() 解除绑定
```

> **默认约定**：UI 订阅 Progress；审批系统监听 Control；治理/监控消费 Monitor。其余场景尽量通过 Hook 或内置事件完成，避免自定义轮询。

---

## 调试技巧

- 启用 `monitor.state_changed` 日志，确认 Agent 是否卡在某个断点（如 `AWAITING_APPROVAL`）。
- 使用 `agent.status()` 查看 `lastSfpIndex`、`cursor`、`state`，定位卡顿问题。
- 结合 `EventBus.getTimeline()`（内部 API）或 Store 事件日志进行回放。

掌握三通道心智后，就能轻松构建"像同事一样协作"的 Agent 体验。
