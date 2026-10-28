# Event System Guide

KODE SDK's core philosophy is "push only necessary events by default, everything else goes through callbacks". We split interactions into three independent channels:

```
Progress  → Data plane (UI rendering)
Control   → Approval plane (human decisions)
Monitor   → Governance plane (audit/alerting)
```

This guide covers event types, best practices, and common pitfalls for each channel.

---

## Progress: Data Plane

Progress handles all user-visible data streams: text deltas, tool lifecycle, and completion signals. Events are pushed in chronological order and support `cursor`/`bookmark` for resumable streaming.

| Event | Description |
|-------|-------------|
| `think_chunk_start / think_chunk / think_chunk_end` | Model thinking phase (enable via template `exposeThinking`). |
| `text_chunk_start / text_chunk / text_chunk_end` | Text deltas and final segments. |
| `tool:start / tool:error / tool:end` | Tool execution lifecycle; `tool:end` always fires (even on failure). |
| `done` | Current turn complete, includes `bookmark { seq, timestamp }`. |

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

**Best Practices**

- Use **SSE/WebSocket** to push Progress to frontend.
- Save `bookmark`/`cursor`, resume with `since` after disconnection.
- UI only handles display; business logic (approval, governance) goes to Control/Monitor or Hooks.
- Enable `exposeThinking` only when needed; keep it off by default to reduce noise.

**Common Pitfalls**

- Forgetting to consume `done` causes frontend to wait indefinitely.
- Putting approval logic in Progress makes the system hard to extend.

---

When reasoning is enabled, the provider can spend the entire output-token budget on reasoning and return no final text. Agent currently reports stream completion as `done` with `reason: completed` without exposing the provider’s `finish_reason: length`. Check that the reply contains usable text and choose an output budget appropriate for the model; completion alone does not prove that an answer was produced.

## Control: Approval Plane

Register Control handlers before starting a request. Approval pauses the running turn; `chat()` waits for a decision rather than immediately returning `paused`. Reply once through `event.respond()` or `agent.decide()`. Interrupting a turn resolves outstanding approvals as denied. For a single request, `chatStream()` handles send, terminal events, model errors and subscription cleanup; raw subscriptions need application-managed completion and error handling.


Approval has no automatic SDK deadline. The application can set a deadline and respond with deny or interrupt the active turn. Cancel its timer after a decision so a late callback does not try to decide an already settled permission.

Control handles moments requiring human decisions. Events are few but critical, typically persisted to approval systems.

| Event | Description |
|-------|-------------|
| `permission_required` | Tool execution needs approval, includes `call` snapshot and `respond(decision, opts?)` callback. |
| `permission_decided` | Approval result broadcast, includes `callId`, `decision`, `decidedBy`, `note`. |

```typescript
agent.on('permission_required', async (event) => {
  const ticketId = await approvalStore.create({
    agentId: agent.agentId,
    callId: event.call.id,
    tool: event.call.name,
    preview: event.call.inputPreview,
  });

  // Give immediate default response, or wait for UI/approval flow
  await event.respond('deny', { note: `Pending approval ticket ${ticketId}` });
});
```

**Best Practices**

- Combine template `permission.requireApprovalTools` with Hook `preToolUse` for approval strategy.
- If approval needs user decision, save `event.call.id` and call `agent.decide(callId, 'allow' | 'deny', note)` later.
- Re-bind Control event listeners after Resume.

**Common Pitfalls**

- Forgetting to handle `permission_required` causes tool to stay in `AWAITING_APPROVAL`.
- Approval callback errors: `agent.decide` can only be called once, duplicate calls throw "Permission not pending".

---

## Monitor: Governance Plane

Monitor is for platform governance, audit, and alerting. Pushes only when necessary, suitable for logs and metrics.

| Event | Description |
|-------|-------------|
| `state_changed` | Agent state transition (READY / WORKING / PAUSED). |
| `tool_executed` | Tool execution complete, includes duration, approval, audit info. |
| `error` | Categorized error (`phase: model/tool/system`), with detailed context. |
| `todo_changed` / `todo_reminder` | Todo lifecycle events. |
| `file_changed` | FilePool detected external modification. |
| `context_compression` | Context compression summary and ratio. |
| `agent_resumed` | Resume complete, includes auto-sealed list. |
| `tool_manual_updated` | Tool manual injected/refreshed. |

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

**Best Practices**

- Send Monitor events to logging/monitoring platforms for audit and SLA tracking.
- On `file_changed`, auto-trigger reminders or scheduled tasks.
- Log `agent_resumed` events for audit trail of auto-sealing.

**Common Pitfalls**

- Pushing Monitor directly to end users creates noise; filter on backend first.
- Ignoring `severity` field mixes critical errors with informational messages.

---

## subscribe vs on: When to Use Which?

- `agent.subscribe([...])` → **Ordered event stream**, ideal for frontend/SSE/WebSocket. Supports `{ since, kinds }` filtering. Returns `AsyncIterable`, remember to handle `done` and close connection.
- `agent.on(type, handler)` → **Callback-style listener**, ideal for backend logic (approval, audit, alerting). Returns `unsubscribe` function, must re-bind after Resume.

```typescript
const stream = agent.subscribe(['progress', 'monitor']);
const iterator = stream[Symbol.asyncIterator]();

// Backend governance
const off = agent.on('tool_executed', handler);
// Call off() to unsubscribe when appropriate
```

> **Convention**: UI subscribes to Progress; approval systems listen to Control; governance/monitoring consumes Monitor. For other scenarios, use Hooks or built-in events, avoid custom polling.

---

## Debugging Tips

- Enable `monitor.state_changed` logging to check if Agent is stuck at a breakpoint (e.g., `AWAITING_APPROVAL`).
- Use `agent.status()` to view `lastSfpIndex`, `cursor`, `state` for debugging stalls.
- Combine `EventBus.getTimeline()` (internal API) or Store event logs for replay.

Master the three-channel mindset to build "collaborate like a colleague" Agent experiences.
