import type { ObservationKind } from '../types';
import type { OTelSpanKind } from './types';

export interface OTelObservationMapping {
  spanName: string;
  kind: OTelSpanKind;
}

const OBSERVATION_MAPPINGS: Record<ObservationKind, OTelObservationMapping> = {
  agent_run: { spanName: 'agent.run', kind: 'internal' },
  generation: { spanName: 'llm.generation', kind: 'client' },
  tool: { spanName: 'tool.call', kind: 'client' },
  subagent: { spanName: 'agent.delegate', kind: 'internal' },
  compression: { spanName: 'context.compression', kind: 'internal' },
};

export function getOTelObservationMapping(kind: ObservationKind): OTelObservationMapping {
  return OBSERVATION_MAPPINGS[kind];
}
