import type { ObservationEnvelope, ObservationKind, ObservationSink, ObservationStatus } from '../types';

export type OTelAttributeValue = string | number | boolean;
export type OTelSpanKind = 'internal' | 'client' | 'server';
export type OTelExportMode = 'immediate' | 'batched';
export type OTelAttributeNamespace = 'kode' | 'gen_ai' | 'dual';

export interface OTelSpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, OTelAttributeValue>;
}

export interface OTelSpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: OTelSpanKind;
  startTime: number;
  endTime?: number;
  status: ObservationStatus;
  attributes: Record<string, OTelAttributeValue>;
  events?: OTelSpanEvent[];
}

export interface OTelMaskingPolicy {
  enabled?: boolean;
  mask?: (params: { key: string; value: OTelAttributeValue }) => OTelAttributeValue;
  redactPatterns?: RegExp[];
}

export interface OTelFilteringPolicy {
  kinds?: ObservationKind[];
  statuses?: ObservationStatus[];
  predicate?: (params: { envelope: ObservationEnvelope; span: OTelSpanData }) => boolean;
}

export type OTelSamplingPolicy =
  | { strategy: 'always_on' }
  | { strategy: 'always_off' }
  | { strategy: 'trace_ratio'; ratio: number };

export interface OTelSpanExporter {
  export(spans: OTelSpanData[]): void | Promise<void>;
  forceFlush?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

export interface OTelObservationBridge extends ObservationSink {
  forceFlush?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

export interface OTelHttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type OTelFetchLike = (url: string, init: {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<OTelHttpResponseLike>;

export interface OTLPHttpJsonExporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  fetch?: OTelFetchLike;
}

export interface OTelBridgeConfig {
  enabled?: boolean;
  exporter?: OTelSpanExporter;
  endpoint?: string;
  headers?: Record<string, string>;
  exportMode?: OTelExportMode;
  batchSize?: number;
  flushIntervalMs?: number;
  masking?: OTelMaskingPolicy;
  filtering?: OTelFilteringPolicy;
  sampling?: OTelSamplingPolicy;
  attributeNamespace?: OTelAttributeNamespace;
  serviceName?: string;
  fetch?: OTelFetchLike;
}
