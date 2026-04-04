# Observability Guide

KODE exposes observability as SDK capabilities first, not as an application server.

That means the SDK gives you structured metrics, observations, persistence hooks, and OTEL bridging. Your application decides whether to expose them through HTTP, dashboards, alerting, or internal admin tools.

---

## What KODE Includes

- Runtime metrics via `agent.getMetricsSnapshot()`
- Runtime observation reads via `agent.getObservationReader()`
- Runtime observation streaming via `agent.subscribeObservations()`
- Optional persisted observation queries via `observability.persistence`
- Optional OTEL export via `observability.otel`

## What KODE Deliberately Does Not Include

- Built-in HTTP server lifecycle
- Built-in auth, tenant isolation, or rate limiting
- Built-in observability dashboard UI
- Opinionated public API contracts for app delivery

Those concerns belong in your application layer.

---

## Runtime Metrics and Observations

Use runtime readers when you want to inspect the current agent process without waiting for external exports.

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

Typical runtime uses:

- show "live now" generation/tool activity in an admin panel
- inspect approval waits, tool errors, and compression events
- derive counters without polling raw event buses

---

## Persisted Observations

Use persisted readers when you need history, audit views, or process-restart durability.

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

Use persisted storage for:

- audit timelines
- run replay pages
- offline analytics jobs
- debugging after process restart

---

## OTEL Bridge

If your platform already standardizes on OpenTelemetry, enable the bridge and ship translated spans to your collector.

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

Keep KODE's native observation model as your source of truth. OTEL is best treated as an interoperability/export path.

---

## Data Safety and Capture Boundaries

KODE supports configurable capture levels through `observability.capture`:

- `off`
- `summary`
- `full`
- `redacted`

Prefer `summary` or `redacted` for production unless you have a clear compliance reason to store more detail.

Also note:

- provider-specific raw payloads are not part of the public observation schema
- debug-only extensions may appear under `metadata.__debug`
- `metadata.__debug` should be treated as internal/private and filtered before external exposure

This keeps the public observation model safer and more stable.

---

## Exposing Observability over HTTP

If you need HTTP endpoints, build them in your app on top of the SDK readers/backends.

Reference example:

- `examples/08-observability-http.ts`
- run with `npm run example:observability-http`

That example demonstrates:

- a normal app-owned HTTP server
- `POST /agents/demo/send` to drive an agent run
- `GET /api/observability/.../metrics` for runtime metrics
- `GET /api/observability/.../observations/runtime` for live observation reads
- `GET /api/observability/.../observations/persisted` for persisted history

This boundary is intentional: the SDK provides observability primitives, while the app owns transport, auth, and presentation.

---

## Recommended Rollout

1. Start with runtime metrics and runtime observation readers.
2. Add persisted observation storage for auditability.
3. Add OTEL export only if your platform needs centralized telemetry.
4. Add app-layer HTTP or UI only after the data model and filtering policy are clear.

This order keeps the SDK integration stable and avoids prematurely coupling KODE to one delivery surface.
