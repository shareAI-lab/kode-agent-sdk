import {
  OTLPHttpJsonExporter,
  buildOTLPTraceExportBody,
  type OTelSpanData,
} from '../../../../src';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability OTel Exporter');

function createSpan(): OTelSpanData {
  return {
    traceId: '0123456789abcdef0123456789abcdef',
    spanId: '0123456789abcdef',
    parentSpanId: 'fedcba9876543210',
    name: 'agent.run',
    kind: 'internal',
    startTime: 1710000000000,
    endTime: 1710000000500,
    status: 'ok',
    attributes: {
      'kode.step': 2,
      'kode.duration.ms': 500,
      'kode.agent.id': 'agent-1',
    },
    events: [
      {
        name: 'kode.observation',
        timestamp: 1710000000500,
        attributes: {
          'kode.observation.kind': 'agent_run',
        },
      },
    ],
  };
}

runner
  .test('buildOTLPTraceExportBody 会生成 OTLP JSON payload', async () => {
    const body = buildOTLPTraceExportBody([createSpan()], 'kode-test-service') as any;
    const resourceSpan = body.resourceSpans[0];
    const span = resourceSpan.scopeSpans[0].spans[0];

    expect.toEqual(resourceSpan.resource.attributes[0].key, 'service.name');
    expect.toEqual(resourceSpan.resource.attributes[0].value.stringValue, 'kode-test-service');
    expect.toEqual(span.name, 'agent.run');
    expect.toEqual(span.kind, 1);
    expect.toEqual(span.attributes[0].key, 'kode.step');
    expect.toEqual(span.attributes[0].value.intValue, '2');
    expect.toEqual(span.events[0].name, 'kode.observation');
  })
  .test('OTLPHttpJsonExporter 会发送 JSON 并在失败时抛错', async () => {
    const requests: Array<{ url: string; init: any }> = [];
    const exporter = new OTLPHttpJsonExporter({
      endpoint: 'https://otel.example/v1/traces',
      headers: { authorization: 'Bearer token' },
      serviceName: 'kode-exporter-test',
      fetch: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return 'ok';
          },
        };
      },
    });

    await exporter.export([createSpan()]);

    expect.toHaveLength(requests, 1);
    expect.toEqual(requests[0].url, 'https://otel.example/v1/traces');
    expect.toEqual(requests[0].init.method, 'POST');
    expect.toEqual(requests[0].init.headers.authorization, 'Bearer token');
    expect.toContain(requests[0].init.body, 'kode-exporter-test');

    const failingExporter = new OTLPHttpJsonExporter({
      endpoint: 'https://otel.example/v1/traces',
      fetch: async () => ({
        ok: false,
        status: 500,
        async text() {
          return 'boom';
        },
      }),
    });

    await expect.toThrow(async () => {
      await failingExporter.export([createSpan()]);
    }, 'OTLP export failed with status 500: boom');
  });

export async function run() {
  return runner.run();
}
