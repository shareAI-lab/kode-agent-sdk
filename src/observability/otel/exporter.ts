import { fetch as undiciFetch } from 'undici';

import type {
  OTLPHttpJsonExporterConfig,
  OTelAttributeValue,
  OTelSpanData,
  OTelSpanExporter,
} from './types';

function toUnixNano(timestampMs: number): string {
  return `${Math.max(0, Math.floor(timestampMs))}000000`;
}

function mapSpanKind(kind: OTelSpanData['kind']): number {
  switch (kind) {
    case 'internal':
      return 1;
    case 'server':
      return 2;
    case 'client':
      return 3;
    default:
      return 1;
  }
}

function mapStatusCode(status: OTelSpanData['status']): number {
  switch (status) {
    case 'ok':
      return 1;
    case 'error':
      return 2;
    case 'cancelled':
      return 0;
    default:
      return 0;
  }
}

function attributeValueToOtlp(value: OTelAttributeValue): Record<string, string | number | boolean> {
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'number':
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    case 'boolean':
      return { boolValue: value };
    default:
      return { stringValue: String(value) };
  }
}

export function buildOTLPTraceExportBody(spans: OTelSpanData[], serviceName = 'kode-observability'): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: serviceName },
            },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: '@shareai-lab/kode-sdk/observability',
            },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: span.name,
              kind: mapSpanKind(span.kind),
              startTimeUnixNano: toUnixNano(span.startTime),
              endTimeUnixNano: toUnixNano(span.endTime ?? span.startTime),
              attributes: Object.entries(span.attributes).map(([key, value]) => ({
                key,
                value: attributeValueToOtlp(value),
              })),
              events: (span.events || []).map((event) => ({
                name: event.name,
                timeUnixNano: toUnixNano(event.timestamp),
                attributes: Object.entries(event.attributes || {}).map(([key, value]) => ({
                  key,
                  value: attributeValueToOtlp(value),
                })),
              })),
              status: {
                code: mapStatusCode(span.status),
              },
            })),
          },
        ],
      },
    ],
  };
}

export class OTLPHttpJsonExporter implements OTelSpanExporter {
  private readonly fetchImpl;

  constructor(private readonly config: OTLPHttpJsonExporterConfig) {
    this.fetchImpl = config.fetch ?? undiciFetch;
  }

  async export(spans: OTelSpanData[]): Promise<void> {
    if (spans.length === 0) {
      return;
    }

    const response = await this.fetchImpl(this.config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.headers || {}),
      },
      body: JSON.stringify(buildOTLPTraceExportBody(spans, this.config.serviceName)),
    });

    if (!response.ok) {
      throw new Error(`OTLP export failed with status ${response.status}: ${await response.text()}`);
    }
  }

  async forceFlush(): Promise<void> {
    return;
  }

  async shutdown(): Promise<void> {
    return;
  }
}
