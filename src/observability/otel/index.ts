export { buildBaseOTelAttributes, buildObservationSpecificAttributes, toOTelSpanId, toOTelTraceId } from './attributes';
export { buildOTLPTraceExportBody, OTLPHttpJsonExporter } from './exporter';
export { getOTelObservationMapping } from './mapping';
export { applyOTelPolicies, maskOTelSpan, shouldExportOTelSpan, shouldSampleOTelTrace } from './policy';
export { createOTelExporter, OTelObservationSink } from './sink';
export { createOTelSpanTranslator, translateObservationToOTelSpan } from './translator';
export type {
  OTelAttributeNamespace,
  OTelAttributeValue,
  OTelBridgeConfig,
  OTelExportMode,
  OTelFetchLike,
  OTelFilteringPolicy,
  OTelHttpResponseLike,
  OTelMaskingPolicy,
  OTelObservationBridge,
  OTelSamplingPolicy,
  OTelSpanData,
  OTelSpanEvent,
  OTelSpanExporter,
  OTelSpanKind,
  OTLPHttpJsonExporterConfig,
} from './types';
