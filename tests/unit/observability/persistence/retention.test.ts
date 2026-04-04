import {
  applyObservationRetention,
  type ObservationEnvelope,
} from '../../../../src';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability Persistence Retention');

function makeEnvelope(agentId: string, seq: number, timestamp: number): ObservationEnvelope {
  return {
    seq,
    timestamp,
    observation: {
      kind: 'agent_run',
      agentId,
      runId: `${agentId}-run-${seq}`,
      traceId: `${agentId}-trace-${seq}`,
      spanId: `${agentId}-span-${seq}`,
      name: 'agent.run',
      status: 'ok',
      startTime: timestamp,
      endTime: timestamp + 10,
      durationMs: 10,
      trigger: 'send',
      step: seq,
      messageCountBefore: 1,
    },
  };
}

runner
  .test('applyObservationRetention enforces maxEntriesPerAgent', async () => {
    const now = 2_000;
    const input = [
      makeEnvelope('agent-a', 1, 1_000),
      makeEnvelope('agent-a', 2, 1_100),
      makeEnvelope('agent-a', 3, 1_200),
      makeEnvelope('agent-b', 1, 1_300),
      makeEnvelope('agent-b', 2, 1_400),
    ];

    const retained = applyObservationRetention(input, { maxEntriesPerAgent: 2 }, now);
    expect.toHaveLength(retained.envelopes, 4);
    expect.toEqual(retained.result.deleted, 1);
    expect.toEqual(retained.envelopes[0].observation.runId, 'agent-a-run-2');
  })
  .test('applyObservationRetention enforces maxAgeMs before count pruning', async () => {
    const input = [
      makeEnvelope('agent-a', 1, 1_000),
      makeEnvelope('agent-a', 2, 1_500),
      makeEnvelope('agent-a', 3, 1_900),
    ];

    const retained = applyObservationRetention(input, { maxAgeMs: 300 }, 2_000);
    expect.toHaveLength(retained.envelopes, 1);
    expect.toEqual(retained.envelopes[0].observation.runId, 'agent-a-run-3');
  });

export async function run() {
  return runner.run();
}
