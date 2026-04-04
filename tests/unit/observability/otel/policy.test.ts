import {
  applyOTelPolicies,
  maskOTelSpan,
  shouldExportOTelSpan,
  shouldSampleOTelTrace,
  type ObservationEnvelope,
  type ToolObservation,
  type OTelSpanData,
} from '../../../../src';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability OTel Policy');

function createEnvelope(overrides?: Partial<ToolObservation>): ObservationEnvelope<ToolObservation> {
  return {
    seq: 1,
    timestamp: 1710000000000,
    observation: {
      kind: 'tool',
      agentId: 'agent-1',
      runId: 'run-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      parentSpanId: 'parent-1',
      name: 'tool:fs_read',
      status: 'error',
      startTime: 1710000000000,
      endTime: 1710000000100,
      durationMs: 100,
      toolCallId: 'call-1',
      toolName: 'fs_read',
      toolState: 'FAILED',
      approvalRequired: false,
      errorMessage: 'Bearer secret-token',
      ...overrides,
    },
  };
}

function createSpan(): OTelSpanData {
  return {
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: '0123456789abcdef',
    parentSpanId: 'fedcba9876543210',
    name: 'tool.call',
    kind: 'client',
    startTime: 1710000000000,
    endTime: 1710000000100,
    status: 'error',
    attributes: {
      authorization: 'Bearer secret-token',
      api_key: 'api_key=secret',
      normal: 'keep-me',
    },
    events: [
      {
        name: 'exception',
        timestamp: 1710000000100,
        attributes: {
          details: 'sk-secret-value',
        },
      },
    ],
  };
}

runner
  .test('filtering policy 可按 kind 和 status 拦截导出', async () => {
    const envelope = createEnvelope();
    const span = createSpan();

    expect.toEqual(
      shouldExportOTelSpan(envelope, span, {
        filtering: {
          kinds: ['tool'],
          statuses: ['error'],
        },
      }),
      true
    );
    expect.toEqual(
      shouldExportOTelSpan(envelope, span, {
        filtering: {
          kinds: ['generation'],
        },
      }),
      false
    );
  })
  .test('sampling policy 对同一 trace 保持稳定且支持边界值', async () => {
    expect.toEqual(shouldSampleOTelTrace('trace-a', { strategy: 'always_on' }), true);
    expect.toEqual(shouldSampleOTelTrace('trace-a', { strategy: 'always_off' }), false);
    expect.toEqual(shouldSampleOTelTrace('trace-a', { strategy: 'trace_ratio', ratio: 0 }), false);
    expect.toEqual(shouldSampleOTelTrace('trace-a', { strategy: 'trace_ratio', ratio: 1 }), true);

    const first = shouldSampleOTelTrace('trace-stable', { strategy: 'trace_ratio', ratio: 0.5 });
    const second = shouldSampleOTelTrace('trace-stable', { strategy: 'trace_ratio', ratio: 0.5 });
    expect.toEqual(first, second);
  })
  .test('masking policy 会在 attributes 与 events 上执行脱敏', async () => {
    const masked = maskOTelSpan(createSpan(), {
      masking: {
        mask: ({ key, value }) => (key === 'normal' ? 'custom-mask' : value),
      },
    });

    expect.toEqual(masked.attributes.authorization, 'Bearer ***');
    expect.toEqual(masked.attributes.api_key, 'api_key=***');
    expect.toEqual(masked.attributes.normal, 'custom-mask');
    expect.toEqual(masked.events?.[0].attributes?.details, 'sk-***');

    const applied = applyOTelPolicies(createEnvelope(), createSpan(), {
      filtering: { kinds: ['tool'] },
      sampling: { strategy: 'always_on' },
    });
    expect.toBeTruthy(applied);

    const dropped = applyOTelPolicies(createEnvelope(), createSpan(), {
      sampling: { strategy: 'always_off' },
    });
    expect.toEqual(dropped, undefined);
  });

export async function run() {
  return runner.run();
}
