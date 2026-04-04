import fs from 'node:fs';
import path from 'node:path';

import {
  SqliteStore,
  SqliteStoreObservationBackend,
} from '../../../../src';
import { TEST_ROOT } from '../../../helpers/fixtures';
import { ensureCleanDir } from '../../../helpers/setup';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability Persistence Sqlite Backend');

runner.test('SqliteStoreObservationBackend persists and prunes observations', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const dir = path.join(TEST_ROOT, `obs-persist-sqlite-${suffix}`);
  ensureCleanDir(dir);

  const dbPath = path.join(dir, 'agents.db');
  const store = new SqliteStore(dbPath, dir);
  const backend = new SqliteStoreObservationBackend(store);

  try {
    await backend.append({
      seq: 0,
      timestamp: 1_710_000_000_000,
      observation: {
        kind: 'agent_run',
        agentId: 'agent-a',
        runId: 'run-a',
        traceId: 'trace-a',
        spanId: 'span-a',
        name: 'agent.run',
        status: 'ok',
        startTime: 1_710_000_000_000,
        endTime: 1_710_000_000_010,
        durationMs: 10,
        trigger: 'send',
        step: 1,
        messageCountBefore: 1,
        metadata: { templateId: 'template-a' },
      },
    });

    await backend.append({
      seq: 1,
      timestamp: 1_710_000_000_100,
      observation: {
        kind: 'generation',
        agentId: 'agent-a',
        runId: 'run-a',
        traceId: 'trace-a',
        spanId: 'span-b',
        parentSpanId: 'span-a',
        name: 'generation:gpt',
        status: 'ok',
        startTime: 1_710_000_000_100,
        endTime: 1_710_000_000_110,
        durationMs: 10,
        provider: 'mock',
        model: 'gpt',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
        metadata: { templateId: 'template-a' },
      },
    });

    await backend.append({
      seq: 2,
      timestamp: 1_710_000_000_200,
      observation: {
        kind: 'agent_run',
        agentId: 'agent-a',
        runId: 'run-b',
        traceId: 'trace-b',
        spanId: 'span-c',
        name: 'agent.run',
        status: 'error',
        startTime: 1_710_000_000_200,
        endTime: 1_710_000_000_220,
        durationMs: 20,
        trigger: 'send',
        step: 2,
        messageCountBefore: 2,
        metadata: { templateId: 'template-b' },
      },
    });

    const runView = await backend.getRun('run-a');
    expect.toBeTruthy(runView);
    expect.toHaveLength(runView?.observations || [], 2);

    const byTemplate = await backend.list({ templateIds: ['template-b'] });
    expect.toHaveLength(byTemplate, 1);
    expect.toEqual(byTemplate[0].observation.runId, 'run-b');

    const pruned = await backend.prune({ maxEntriesPerAgent: 2 });
    expect.toEqual(pruned.deleted, 1);

    const remaining = await backend.list();
    expect.toHaveLength(remaining, 2);
    expect.toEqual(remaining[0].observation.runId, 'run-a');
    expect.toEqual(remaining[1].observation.runId, 'run-b');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export async function run() {
  return runner.run();
}
