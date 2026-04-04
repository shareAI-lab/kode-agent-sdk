import {
  createStoreBackedObservationReader,
  type ObservationEnvelope,
  type ObservationQueryBackend,
} from '../../../../src';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability Persistence Reader');

runner.test('createStoreBackedObservationReader delegates to backend methods', async () => {
  const listCalls: any[] = [];
  const runCalls: string[] = [];
  const expected: ObservationEnvelope[] = [
    {
      seq: 1,
      timestamp: 1_710_000_000_001,
      observation: {
        kind: 'agent_run',
        agentId: 'agent-1',
        runId: 'run-1',
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'agent.run',
        status: 'ok',
        startTime: 1_710_000_000_001,
        endTime: 1_710_000_000_011,
        durationMs: 10,
        trigger: 'send',
        step: 1,
        messageCountBefore: 1,
      },
    },
  ];

  const backend: ObservationQueryBackend = {
    async append() {
      return;
    },
    async list(opts) {
      listCalls.push(opts);
      return expected;
    },
    async getRun(runId) {
      runCalls.push(runId);
      return {
        run: expected[0] as any,
        observations: expected,
      };
    },
  };

  const reader = createStoreBackedObservationReader(backend);
  const listed = await reader.listObservations({ runId: 'run-1' });
  const runView = await reader.getRun('run-1');

  expect.toHaveLength(listed, 1);
  expect.toEqual(listCalls[0].runId, 'run-1');
  expect.toEqual(runCalls[0], 'run-1');
  expect.toEqual(runView?.run.observation.runId, 'run-1');
});

export async function run() {
  return runner.run();
}
