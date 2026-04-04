import fs from 'node:fs';
import path from 'node:path';

import {
  JSONStoreObservationBackend,
  type ObservationEnvelope,
  type ObservationRecord,
} from '../../../../src';
import { TEST_ROOT } from '../../../helpers/fixtures';
import { ensureCleanDir } from '../../../helpers/setup';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability Persistence Backend Contract');

function makeEnvelope(
  seq: number,
  observation: ObservationRecord,
  timestamp = 1_710_000_000_000 + seq * 10
): ObservationEnvelope {
  return {
    seq,
    timestamp,
    observation,
  };
}

function makeAgentRun(agentId: string, runId: string, templateId: string, seq: number): ObservationEnvelope {
  return makeEnvelope(seq, {
    kind: 'agent_run',
    agentId,
    runId,
    traceId: `trace-${runId}`,
    spanId: `span-run-${seq}`,
    name: 'agent.run',
    status: 'ok',
    startTime: 1_710_000_000_000 + seq * 10,
    endTime: 1_710_000_000_010 + seq * 10,
    durationMs: 10,
    trigger: 'send',
    step: seq,
    messageCountBefore: seq,
    metadata: { templateId },
  });
}

function makeGeneration(agentId: string, runId: string, seq: number): ObservationEnvelope {
  return makeEnvelope(seq, {
    kind: 'generation',
    agentId,
    runId,
    traceId: `trace-${runId}`,
    spanId: `span-gen-${seq}`,
    parentSpanId: `span-run-${seq - 1}`,
    name: 'generation:gpt',
    status: 'ok',
    startTime: 1_710_000_000_000 + seq * 10,
    endTime: 1_710_000_000_015 + seq * 10,
    durationMs: 15,
    provider: 'mock',
    model: 'gpt',
    usage: {
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
    },
    metadata: { templateId: 'template-a' },
  });
}

runner.test('JSONStoreObservationBackend supports append/list/getRun filters', async () => {
  const dir = path.join(TEST_ROOT, `obs-persist-backend-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  ensureCleanDir(dir);
  const backend = new JSONStoreObservationBackend(dir);

  try {
    await backend.append(makeAgentRun('agent-a', 'run-a', 'template-a', 0));
    await backend.append(makeGeneration('agent-a', 'run-a', 1));
    await backend.append(makeAgentRun('agent-b', 'run-b', 'template-b', 0));

    const all = await backend.list();
    expect.toHaveLength(all, 3);
    expect.toEqual(all[0].observation.agentId, 'agent-a');
    expect.toEqual(all[1].observation.agentId, 'agent-b');
    expect.toEqual(all[2].observation.kind, 'generation');

    const byRun = await backend.list({ runId: 'run-a' });
    expect.toHaveLength(byRun, 2);

    const byKinds = await backend.list({ kinds: ['generation'] });
    expect.toHaveLength(byKinds, 1);
    expect.toEqual(byKinds[0].observation.kind, 'generation');

    const byTemplate = await backend.list({ templateIds: ['template-b'] });
    expect.toHaveLength(byTemplate, 1);
    expect.toEqual(byTemplate[0].observation.runId, 'run-b');

    const byAgents = await backend.list({ agentIds: ['agent-b'] });
    expect.toHaveLength(byAgents, 1);
    expect.toEqual(byAgents[0].observation.agentId, 'agent-b');

    const runView = await backend.getRun('run-a');
    expect.toBeTruthy(runView);
    expect.toEqual(runView?.run.observation.kind, 'agent_run');
    expect.toHaveLength(runView?.observations || [], 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export async function run() {
  return runner.run();
}
