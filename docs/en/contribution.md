# Contribution Guide

Thank you for contributing to KODE SDK. This guide explains the requirements and process for submitting PRs.

## Scope
- Code changes
- Documentation changes
- Example changes
- Test changes
- Release-related changes

## Before You Start
- Search existing issues and documentation to avoid duplicate work.
- For major features or behavioral changes, consider opening an issue or discussion first.
- Each PR should focus on one thing; avoid mixing unrelated changes.

## Branch Strategy
- Create a new branch from the `main` branch.
- Suggested branch naming: `feat/<short-desc>`, `fix/<short-desc>`, `docs/<short-desc>`.

## PR Description
- Required: purpose, scope of changes, impact/compatibility, test results.
- Recommended: related issue/requirement links, screenshots or logs (if applicable).

## Scope of Changes
- Avoid mixing unrelated changes in a single PR.
- Avoid unnecessary formatting or large-scale reorganization unless necessary and explained.

## Code Quality
- Tests related to your changes must pass.
- New features must include tests or explain why not.
- Avoid obvious performance regressions and security risks.
- Follow existing TypeScript style, module boundaries, and public API stability.

## Dependencies and Build Artifacts
- Use only one package manager per PR and update only the corresponding lock file: `package-lock.json` or `pnpm-lock.yaml`.
- Do not commit build artifacts like `dist/` unless required for release or requested by maintainers.

## Breaking Changes
- Avoid breaking changes in principle.
- If unavoidable, mark `BREAKING` in the PR title or description and submit a detailed report.
- Provide transition solutions such as compatibility layers, deprecation periods, and migration steps.
- The report should include: scope of impact, migration steps, transition strategy, risks, and rollback plan.

## Testing (Required)
- `npm run test:unit` must pass.
- When involving DB, provider, sandbox, or cross-module flows, run `test:integration` or `test:e2e`.
- New features require at least unit tests; add integration or end-to-end tests when necessary.

## Test Format
- Place test files in `tests/unit`, `tests/integration`, or `tests/e2e`.
- Use `*.test.ts` naming convention.
- Use `TestRunner` and `expect` from `tests/helpers/utils.ts`.
- Use `createUnitTestAgent` and `createIntegrationTestAgent` from `tests/helpers/setup.ts` when needed.
- Each test file exports `export async function run() { ... }`.
- For complex flows, use `tests/helpers/integration-harness.ts`.
- Refer to `../../tests/README.md` as the specification reference.

## Test Design Requirements
- Cover normal paths, critical boundaries, and failure paths.
- New features should cover core behavior and key boundary scenarios at minimum.
- Unit tests should avoid real API/network dependencies; use integration or e2e for real model testing.
- Assertions must verify results or side effects (return status, events, persisted results, etc.).
- Use `cleanup` mechanisms to clean up temporary directories and resources.
- Avoid flaky factors (randomness, time dependencies); fix inputs or use mocks when necessary.

## Test Examples
Unit test example (from `tests/unit/utils/agent-id.test.ts`):
```ts
import { generateAgentId } from '../../../src/utils/agent-id';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('AgentId');

// Crockford Base32 character set (used for timestamp encoding)
const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

runner
  .test('Generated AgentId is unique and contains timestamp', async () => {
    const id1 = generateAgentId();
    const id2 = generateAgentId();

    // Verify uniqueness
    expect.toEqual(id1 !== id2, true);

    // Verify format: agt-{timestamp 10 chars}{random 16 chars}
    expect.toContain(id1, 'agt-');
    expect.toEqual(id1.length, 4 + 10 + 16); // agt- + timestamp + random

    // Verify timestamp part (first 10 chars) is valid Crockford Base32
    const timePart = id1.slice(4, 14);
    for (const char of timePart) {
      expect.toEqual(
        CROCKFORD32.includes(char),
        true,
        `Timestamp character '${char}' is not valid Crockford Base32`
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

const runner = new TestRunner('Integration Test - Event System');

runner.test('Subscribe to progress and monitor events', async () => {
  console.log('\n[Event Test] Test objectives:');
  console.log('  1) Verify progress stream contains text_chunk and done events');
  console.log('  2) Verify monitor channel broadcasts state_changed');

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

const runner = new TestRunner('E2E - Long-running Flow');

runner
  .test('Todo, events, and snapshots work together', async () => {
    const { agent, cleanup, storeDir } = await createUnitTestAgent({
      enableTodo: true,
      mockResponses: ['First turn', 'Second turn', 'Final response'],
    });

    const monitorEventsPromise = collectEvents(agent, ['monitor'], (event) => event.type === 'todo_reminder');

    await agent.setTodos([{ id: 't1', title: 'Write tests', status: 'pending' }]);
    await agent.chat('Start task');
    await agent.chat('Continue execution');

    const todos = agent.getTodos();
    expect.toEqual(todos.length, 1);

    const reminderEvents = await monitorEventsPromise;
    expect.toBeGreaterThan(reminderEvents.length, 0);

    await agent.updateTodo({ id: 't1', title: 'Write tests', status: 'completed' });
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

## Documentation and Examples
- User-visible changes require updating `docs`.
- Keep `docs/en` and `docs/zh-CN` in sync.
- Behavior or API changes require updating examples.
- If documentation cannot be synced, explain why and provide a catch-up plan.

## Documentation Format
- Use Markdown with a single `#` title at the top; organize content with `##` / `###` without skipping levels.
- Code blocks must specify the language (e.g., `ts`, `bash`, `json`).
- Use relative path links for in-project documentation.
- Public API references must match exports in `src/index.ts`.
- New documentation should be added to the README documentation table.

## Commit Messages
- No strict format required, but must clearly describe the changes.

## PR Template
- Use `.github/pull_request_template.md`.

## Review
- A maintainer may merge after technical review and successful applicable CI checks. A separate approving review is optional.
- High-risk changes should have additional reviewers.

## Changelog
- `CHANGELOG` is not currently maintained.
- Change history is based on `git log`.
- Version numbers are handled by maintainers.

## Security and Licenses
- Never commit keys, tokens, or private data.
- New dependencies require justification and license compatibility verification.

## DCO / CLA
- DCO or CLA is not currently required.
