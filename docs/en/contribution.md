# Contribution Guide

Thank you for contributing to KODE SDK. This guide defines the expectations for pull requests (PRs).

## Scope
- Code changes
- Documentation changes
- Example updates
- Test updates
- Release-related changes

## Before You Start
- Check existing issues and docs to avoid duplicate work.
- For large features or behavior changes, open an issue or discussion first.
- Keep each PR focused on a single topic.

## Branching
- Branch from `main`.
- Suggested names: `feat/<short-desc>`, `fix/<short-desc>`, `docs/<short-desc>`.

## PR Description
- Must include: purpose, change scope, impact/compatibility, and test results.
- Should include: related issue link, screenshots or logs when applicable.

## Change Scope
- Avoid mixing unrelated changes in one PR.
- Avoid unrelated formatting or large refactors unless necessary and explained.

## Code Quality
- Tests related to the change must pass.
- New features must include tests or clearly explain why not.
- Avoid obvious performance regressions and security risks.
- Follow existing TypeScript style, module boundaries, and public API stability.

## Dependencies and Build Artifacts
- Use only one package manager in a PR and update only its lockfile: `package-lock.json` or `pnpm-lock.yaml`.
- Do not commit `dist/` or other build outputs unless release or maintainer request.

## Breaking Changes
- Breaking changes should be avoided whenever possible.
- If unavoidable, mark `BREAKING` in the PR title or description and provide a detailed report.
- Provide a transition plan such as compatibility layers, deprecation window, and migration steps.
- The report should include: scope of impact, migration steps, transition strategy, risks and rollback plan.

## Tests (Required)
- `npm run test:unit` must pass.
- Run `test:integration` or `test:e2e` when changes affect DB, providers, sandbox, or cross-module flows.
- If tests are not run, explain why in the PR.
- New features must include at least unit tests; add integration or e2e tests when the change requires it.

## Test Format
- Place tests under `tests/unit`, `tests/integration`, or `tests/e2e`.
- Name test files as `*.test.ts`.
- Use `TestRunner` and `expect` from `tests/helpers/utils.ts`.
- Use `createUnitTestAgent` and `createIntegrationTestAgent` from `tests/helpers/setup.ts` when applicable.
- Each test file must export `export async function run() { ... }`.
- For complex flows, use helpers from `tests/helpers/integration-harness.ts`.
- See `../../tests/README.md` for the canonical structure.

## Test Design Requirements
- Cover the happy path, key edge cases, and failure paths.
- New features must cover core behavior and critical boundaries.
- Unit tests must not depend on real APIs or network calls; use integration or e2e for real providers.
- Assertions must validate outcomes or side effects (status, events, persistence, etc.).
- Clean up resources and temp directories (use `cleanup`).
- Avoid flaky inputs (randomness, time); fix inputs or mock when needed.

## Test Examples
Unit test example (from `tests/unit/utils/agent-id.test.ts`):
```ts
import { generateAgentId } from '../../../src/utils/agent-id';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('AgentId');

// Crockford Base32 charset (used for timestamp encoding)
const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

runner
  .test('AgentId is unique and includes timestamp', async () => {
    const id1 = generateAgentId();
    const id2 = generateAgentId();

    // Uniqueness
    expect.toEqual(id1 !== id2, true);

    // Format: agt-{10 timestamp}{16 random}
    expect.toContain(id1, 'agt-');
    expect.toEqual(id1.length, 4 + 10 + 16); // agt- + timestamp + random

    // Timestamp part is valid Crockford Base32
    const timePart = id1.slice(4, 14);
    for (const char of timePart) {
      expect.toEqual(
        CROCKFORD32.includes(char),
        true,
        `timestamp char '${char}' is not valid Crockford Base32`
      );
    }
  });

export async function run() {
  return await runner.run();
}
```

Integration test example (from `tests/integration/features/events.test.ts`):
```ts
import { collectEvents } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';

const runner = new TestRunner('Integration - Event System');

runner.test('subscribe to progress and monitor events', async () => {
  console.log('\n[Event Test] Goals:');
  console.log('  1) progress includes text_chunk and done');
  console.log('  2) monitor emits state_changed');

  const harness = await IntegrationHarness.create();

  const monitorEventsPromise = collectEvents(harness.getAgent(), ['monitor'], (event) => event.type === 'state_changed');

  const { events } = await harness.chatStep({
    label: 'Event Test',
    prompt: 'Please introduce yourself briefly',
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

End-to-end test example (from `tests/e2e/scenarios/long-run.test.ts`):
```ts
import path from 'path';
import fs from 'fs';
import { createUnitTestAgent, collectEvents } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('E2E - Long Running Flow');

runner
  .test('Todo, events, and snapshot work together', async () => {
    const { agent, cleanup, storeDir } = await createUnitTestAgent({
      enableTodo: true,
      mockResponses: ['First turn', 'Second turn', 'Final response'],
    });

    const monitorEventsPromise = collectEvents(agent, ['monitor'], (event) => event.type === 'todo_reminder');

    await agent.setTodos([{ id: 't1', title: 'Write test', status: 'pending' }]);
    await agent.chat('Start task');
    await agent.chat('Continue');

    const todos = agent.getTodos();
    expect.toEqual(todos.length, 1);

    const reminderEvents = await monitorEventsPromise;
    expect.toBeGreaterThan(reminderEvents.length, 0);

    await agent.updateTodo({ id: 't1', title: 'Write test', status: 'completed' });
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

## Docs and Examples
- Update `README` or `docs` for user-facing changes.
- Keep `docs/en` and `docs/zh-CN` aligned when possible.
- Update examples when behavior or API changes.
- If docs cannot be synchronized, explain why and provide a follow-up plan.

## Doc Format
- Use Markdown with a single `#` title and `##` / `###` sections without skipping levels.
- Add language tags for all code blocks (for example `ts`, `bash`, `json`).
- Use relative links for internal docs.
- Public API references must match exports in `src/index.ts`.
- If you add a new doc page, add an entry in the README docs table.

## Commit Messages
- No strict format, but each commit must clearly describe the change.

## PR Template
- Use the PR template at `.github/pull_request_template.md`.

## Review
- At least one maintainer approval is required.
- High-risk changes should include an additional reviewer.

## Change Log
- We do not maintain a `CHANGELOG` at this time.
- `git log` is the source of change history.
- Version bumps are handled by maintainers.

## Security and Licensing
- Do not commit secrets, tokens, or private data.
- New dependencies must be justified and compatible with the project license.

## DCO / CLA
- No DCO or CLA is required at this time.
