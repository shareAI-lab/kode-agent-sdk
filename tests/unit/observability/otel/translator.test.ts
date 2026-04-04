import {
  translateObservationToOTelSpan,
  type GenerationObservation,
  type ObservationEnvelope,
} from '../../../../src';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability OTel Translator');

function createGenerationEnvelope(overrides?: Partial<GenerationObservation>): ObservationEnvelope<GenerationObservation> {
  return {
    seq: 7,
    timestamp: 1710000000123,
    observation: {
      kind: 'generation',
      agentId: 'agent-1',
      runId: 'run-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      parentSpanId: 'parent-1',
      name: 'generation:gpt-4.1',
      status: 'ok',
      startTime: 1710000000000,
      endTime: 1710000000100,
      durationMs: 100,
      provider: 'openai',
      model: 'gpt-4.1',
      requestId: 'req-1',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      request: {
        latencyMs: 100,
        timeToFirstTokenMs: 25,
        stopReason: 'end_turn',
      },
      metadata: {
        templateId: 'template-1',
      },
      ...overrides,
    },
  };
}

runner
  .test('generation observation 可映射为带 dual attributes 的 OTEL span', async () => {
    const envelope = createGenerationEnvelope();
    const span = translateObservationToOTelSpan(envelope, { attributeNamespace: 'dual' });

    expect.toEqual(span.name, 'llm.generation');
    expect.toEqual(span.kind, 'client');
    expect.toEqual(span.traceId.length, 32);
    expect.toEqual(span.spanId.length, 16);
    expect.toEqual(span.parentSpanId?.length, 16);
    expect.toEqual(span.attributes['kode.agent.id'], 'agent-1');
    expect.toEqual(span.attributes['kode.generation.model'], 'gpt-4.1');
    expect.toEqual(span.attributes['gen_ai.system'], 'openai');
    expect.toEqual(span.attributes['gen_ai.request.model'], 'gpt-4.1');
    expect.toEqual(span.attributes['gen_ai.kode.agent_id'], 'agent-1');
    expect.toEqual(span.attributes['kode.duration.ms'], 100);
    expect.toHaveLength(span.events || [], 1);
    expect.toEqual(span.events?.[0].name, 'kode.observation');
  })
  .test('error observation 会生成 exception event', async () => {
    const envelope = createGenerationEnvelope({
      status: 'error',
      errorMessage: 'provider failed',
    });

    const span = translateObservationToOTelSpan(envelope, { attributeNamespace: 'kode' });

    expect.toEqual(span.status, 'error');
    expect.toEqual(span.attributes['kode.error.message'], 'provider failed');
    expect.toEqual(span.attributes['gen_ai.system'], undefined);
    expect.toHaveLength(span.events || [], 2);
    expect.toEqual(span.events?.[1].name, 'exception');
    expect.toEqual(span.events?.[1].attributes?.['exception.message'], 'provider failed');
  });

export async function run() {
  return runner.run();
}
