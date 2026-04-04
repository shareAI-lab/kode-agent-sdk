import type { ObservationEnvelope } from '../types';
import { buildBaseOTelAttributes, buildObservationSpecificAttributes, toOTelSpanId, toOTelTraceId } from './attributes';
import { getOTelObservationMapping } from './mapping';
import type { OTelAttributeNamespace, OTelBridgeConfig, OTelSpanData, OTelSpanEvent } from './types';

function buildSpanEvents(envelope: ObservationEnvelope): OTelSpanEvent[] | undefined {
  const observation = envelope.observation;
  const events: OTelSpanEvent[] = [
    {
      name: 'kode.observation',
      timestamp: envelope.timestamp,
      attributes: {
        'kode.observation.kind': observation.kind,
        'kode.observation.status': observation.status,
      },
    },
  ];

  if ('errorMessage' in observation && typeof observation.errorMessage === 'string' && observation.errorMessage) {
    events.push({
      name: 'exception',
      timestamp: observation.endTime ?? envelope.timestamp,
      attributes: {
        'exception.message': observation.errorMessage,
      },
    });
  }

  return events;
}

export function translateObservationToOTelSpan(
  envelope: ObservationEnvelope,
  opts?: { attributeNamespace?: OTelAttributeNamespace }
): OTelSpanData {
  const observation = envelope.observation;
  const mapping = getOTelObservationMapping(observation.kind);
  const attributeNamespace = opts?.attributeNamespace ?? 'dual';

  return {
    traceId: toOTelTraceId(observation.traceId),
    spanId: toOTelSpanId(observation.spanId),
    parentSpanId: observation.parentSpanId ? toOTelSpanId(observation.parentSpanId) : undefined,
    name: mapping.spanName,
    kind: mapping.kind,
    startTime: observation.startTime,
    endTime: observation.endTime,
    status: observation.status,
    attributes: {
      ...buildBaseOTelAttributes(envelope, attributeNamespace),
      ...buildObservationSpecificAttributes(observation, attributeNamespace),
    },
    events: buildSpanEvents(envelope),
  };
}

export function createOTelSpanTranslator(config?: OTelBridgeConfig) {
  return (envelope: ObservationEnvelope): OTelSpanData =>
    translateObservationToOTelSpan(envelope, { attributeNamespace: config?.attributeNamespace });
}
