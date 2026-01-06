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

## 下一步

- 使用 `examples/` 作为蓝本接入你自己的工具、存储、审批系统。
- 将 Monitor 事件接入现有 observability 平台，沉淀治理与审计能力。
- 参考 `docs/` 中的扩展指南，为企业自定义 Sandbox、模型 Provider 或多团队 Agent 协作流程。

欢迎在 Issue / PR 中分享反馈与场景诉求，让 KODE SDK 更贴近真实协作团队的需求。
