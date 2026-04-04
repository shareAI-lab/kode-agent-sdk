# 可观测性指南

KODE 将可观测性优先设计为 SDK 能力，而不是一个内置应用服务。

也就是说，SDK 负责提供结构化指标、observation、持久化接口与 OTEL bridge；至于是否通过 HTTP、Dashboard、告警系统或内部管理台暴露这些数据，应由你的应用层来决定。

---

## KODE 已提供什么

- 运行时指标：`agent.getMetricsSnapshot()`
- 运行时 observation 读取：`agent.getObservationReader()`
- 运行时 observation 订阅：`agent.subscribeObservations()`
- 可选持久化 observation 查询：`observability.persistence`
- 可选 OTEL 导出：`observability.otel`

## KODE 有意不内置什么

- 内置 HTTP server 生命周期
- 内置鉴权、租户隔离、限流
- 内置观测 Dashboard UI
- 面向应用交付的固定公开 API 契约

这些都应该放在你的应用层。

---

## 运行时指标与 Observation

如果你想直接观察当前 Agent 进程中的行为，而不是等待外部导出链路，优先使用运行时 reader。

```typescript
const metrics = agent.getMetricsSnapshot();
const reader = agent.getObservationReader();

const latest = reader.listObservations({
  kinds: ['generation', 'tool'],
  limit: 20,
});

for await (const envelope of agent.subscribeObservations({ runId: metrics.currentRunId })) {
  console.log(envelope.observation.kind, envelope.observation.name);
}
```

常见用途：

- 在管理台展示“当前正在发生什么”
- 观察审批等待、工具失败、上下文压缩事件
- 在不轮询原始事件总线的情况下提取聚合指标

---

## 持久化 Observation

如果你需要历史数据、审计视图，或者希望在进程重启后仍能查询 observation，就应配置持久化后端。

```typescript
import {
  Agent,
  JSONStoreObservationBackend,
  createStoreBackedObservationReader,
} from '@shareai-lab/kode-sdk';

const observationBackend = new JSONStoreObservationBackend('./.kode-observability');

const agent = await Agent.create({
  templateId: 'assistant',
  observability: {
    persistence: {
      backend: observationBackend,
    },
  },
}, deps);

const persistedReader = createStoreBackedObservationReader(observationBackend);
const history = await persistedReader.listObservations({
  agentIds: [agent.agentId],
  kinds: ['agent_run', 'generation', 'tool'],
  limit: 50,
});
```

适合的场景：

- 审计时间线
- run 回放页面
- 离线分析任务
- 进程重启后的问题排查

---

## OTEL Bridge

如果你的平台已经统一使用 OpenTelemetry，可以启用 bridge，把 KODE 的 observation 转换后导出到已有 collector。

```typescript
const agent = await Agent.create({
  templateId: 'assistant',
  observability: {
    otel: {
      enabled: true,
      serviceName: 'kode-agent',
      exporter: {
        protocol: 'http/json',
        endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT!,
      },
    },
  },
}, deps);
```

建议继续把 KODE 原生 observation 模型作为第一真相源，OTEL 更适合作为互操作/导出路径。

---

## 数据安全与采集边界

KODE 通过 `observability.capture` 支持不同采集等级：

- `off`
- `summary`
- `full`
- `redacted`

生产环境通常优先选择 `summary` 或 `redacted`，除非你有明确的合规或排障理由去保留更多细节。

另外还要注意：

- provider 原始 payload 不属于公共 observation schema
- 调试扩展信息可能出现在 `metadata.__debug`
- `metadata.__debug` 应视为内部/私有字段，对外暴露前必须过滤

这样可以让公共 observation 模型更稳定，也更安全。

---

## 通过 HTTP 暴露观测数据

如果你确实需要 HTTP 接口，请在应用层基于 SDK reader/backend 自行封装。

参考示例：

- `examples/08-observability-http.ts`
- 运行命令：`npm run example:observability-http`

这个示例演示了：

- 应用自己持有 HTTP server
- 用 `POST /agents/demo/send` 驱动一次 agent run
- 用 `GET /api/observability/.../metrics` 获取运行时指标
- 用 `GET /api/observability/.../observations/runtime` 读取运行时 observation
- 用 `GET /api/observability/.../observations/persisted` 读取持久化历史

这个边界是刻意设计的：SDK 负责观测原语，应用负责传输层、鉴权和展示层。

---

## 推荐落地顺序

1. 先接入运行时 metrics 与 runtime observation reader。
2. 再补持久化 observation 后端，保证可审计。
3. 只有在平台需要统一遥测时再接 OTEL。
4. 等数据模型与过滤策略稳定后，再补应用层 HTTP 或管理 UI。

按这个顺序推进，可以最大限度降低耦合，避免过早把 KODE 绑定到某一种交付形式。
