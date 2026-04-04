import {
  PersistedObservationSink,
  type ObservationEnvelope,
  type ObservationQueryBackend,
} from '../../../../src';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability Persistence Sink');

function makeEnvelope(seq: number): ObservationEnvelope {
  return {
    seq,
    timestamp: 1_710_000_000_000 + seq,
    observation: {
      kind: 'agent_run',
      agentId: 'agent-1',
      runId: `run-${seq}`,
      traceId: `trace-${seq}`,
      spanId: `span-${seq}`,
      name: 'agent.run',
      status: 'ok',
      startTime: 1_710_000_000_000 + seq,
      endTime: 1_710_000_000_010 + seq,
      durationMs: 10,
      trigger: 'send',
      step: seq,
      messageCountBefore: 1,
    },
  };
}

runner
  .test('PersistedObservationSink writes envelopes and prunes lazily', async () => {
    const appended: ObservationEnvelope[] = [];
    let pruneCalls = 0;
    const backend: ObservationQueryBackend = {
      async append(envelope) {
        appended.push(envelope);
      },
      async list() {
        return appended;
      },
      async getRun() {
        return undefined;
      },
      async prune() {
        pruneCalls += 1;
        return { deleted: 0, retained: appended.length };
      },
    };

    const sink = new PersistedObservationSink(backend, {
      retention: { maxEntriesPerAgent: 10 },
      pruneIntervalMs: 1_000,
    });

    await sink.onObservation(makeEnvelope(1));
    await sink.onObservation(makeEnvelope(2));

    expect.toHaveLength(appended, 2);
    expect.toEqual(pruneCalls, 1);
  })
  .test('backend append/prune failures do not escape the sink', async () => {
    let appendCalls = 0;
    const backend: ObservationQueryBackend = {
      async append() {
        appendCalls += 1;
        if (appendCalls === 1) {
          throw new Error('append failed');
        }
      },
      async list() {
        return [];
      },
      async getRun() {
        return undefined;
      },
      async prune() {
        throw new Error('prune failed');
      },
    };

    const sink = new PersistedObservationSink(backend, {
      retention: { maxEntriesPerAgent: 1 },
      pruneIntervalMs: 1_000,
    });

    await sink.onObservation(makeEnvelope(1));
    await sink.onObservation(makeEnvelope(2));

    expect.toEqual(appendCalls, 2);
  });

export async function run() {
  return runner.run();
}
