import type { ObservationEnvelope } from '../types';
import type {
  OTelAttributeValue,
  OTelBridgeConfig,
  OTelSamplingPolicy,
  OTelSpanData,
} from './types';
import { createHash } from 'node:crypto';

const DEFAULT_REDACT_PATTERNS = [
  /sk-[a-zA-Z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
  /api[_-]?key[=:]\s*[^,\s]+/gi,
];

function maskString(value: string, patterns: RegExp[]): string {
  return patterns.reduce((current, pattern) => current.replace(pattern, (match) => {
    if (match.startsWith('Bearer ')) return 'Bearer ***';
    if (match.startsWith('sk-')) return 'sk-***';
    const [prefix] = match.split(/[:=]/, 1);
    return `${prefix}=***`;
  }), value);
}

export function shouldExportOTelSpan(envelope: ObservationEnvelope, span: OTelSpanData, config?: OTelBridgeConfig): boolean {
  const filtering = config?.filtering;
  if (!filtering) {
    return true;
  }
  if (filtering.kinds && !filtering.kinds.includes(envelope.observation.kind)) {
    return false;
  }
  if (filtering.statuses && !filtering.statuses.includes(envelope.observation.status)) {
    return false;
  }
  if (filtering.predicate && !filtering.predicate({ envelope, span })) {
    return false;
  }
  return true;
}

export function shouldSampleOTelTrace(traceId: string, sampling?: OTelSamplingPolicy): boolean {
  const resolved = sampling ?? { strategy: 'always_on' as const };
  if (resolved.strategy === 'always_on') {
    return true;
  }
  if (resolved.strategy === 'always_off') {
    return false;
  }

  const ratio = Math.max(0, Math.min(1, resolved.ratio));
  if (ratio === 0) return false;
  if (ratio === 1) return true;

  const bucket = createHash('sha256').update(traceId).digest().readUInt32BE(0) / 0xffffffff;
  return bucket < ratio;
}

export function maskOTelSpan(span: OTelSpanData, config?: OTelBridgeConfig): OTelSpanData {
  const masking = config?.masking;
  if (masking?.enabled === false) {
    return span;
  }

  const redactPatterns = masking?.redactPatterns ?? DEFAULT_REDACT_PATTERNS;

  const maskValue = (key: string, value: OTelAttributeValue): OTelAttributeValue => {
    const custom = masking?.mask?.({ key, value });
    const masked = custom === undefined ? value : custom;
    if (typeof masked === 'string') {
      return maskString(masked, redactPatterns);
    }
    return masked;
  };

  return {
    ...span,
    attributes: Object.fromEntries(
      Object.entries(span.attributes).map(([key, value]) => [key, maskValue(key, value)])
    ),
    events: span.events?.map((event) => ({
      ...event,
      attributes: event.attributes
        ? Object.fromEntries(
            Object.entries(event.attributes).map(([key, value]) => [key, maskValue(key, value)])
          )
        : undefined,
    })),
  };
}

export function applyOTelPolicies(envelope: ObservationEnvelope, span: OTelSpanData, config?: OTelBridgeConfig): OTelSpanData | undefined {
  if (!shouldExportOTelSpan(envelope, span, config)) {
    return undefined;
  }
  if (!shouldSampleOTelTrace(envelope.observation.traceId, config?.sampling)) {
    return undefined;
  }
  return maskOTelSpan(span, config);
}
