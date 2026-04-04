import {
  AgentRunObservation,
  ObservationEnvelope,
  ObservationListOptions,
  ObservationQueryOptions,
  ObservationRunView,
} from './types';

export function matchesObservationEnvelope(
  envelope: ObservationEnvelope,
  opts?: ObservationQueryOptions
): boolean {
  if (!opts) {
    return true;
  }

  if (opts.sinceSeq !== undefined && envelope.seq <= opts.sinceSeq) {
    return false;
  }

  const observation = envelope.observation;

  if (opts.agentId !== undefined && observation.agentId !== opts.agentId) {
    return false;
  }
  if (opts.kinds && !opts.kinds.includes(observation.kind)) {
    return false;
  }
  if (opts.runId !== undefined && observation.runId !== opts.runId) {
    return false;
  }
  if (opts.traceId !== undefined && observation.traceId !== opts.traceId) {
    return false;
  }
  if (opts.parentSpanId !== undefined && observation.parentSpanId !== opts.parentSpanId) {
    return false;
  }
  if (opts.statuses && !opts.statuses.includes(observation.status)) {
    return false;
  }

  return true;
}

export function filterObservationEnvelopes(
  envelopes: ObservationEnvelope[],
  opts?: ObservationListOptions
): ObservationEnvelope[] {
  let filtered = opts ? envelopes.filter((envelope) => matchesObservationEnvelope(envelope, opts)) : [...envelopes];

  if (opts?.limit !== undefined) {
    filtered = filtered.slice(-opts.limit);
  }

  return filtered;
}

export function buildObservationRunView(
  envelopes: ObservationEnvelope[],
  runId: string
): ObservationRunView | undefined {
  const observations = envelopes.filter((envelope) => envelope.observation.runId === runId);
  if (observations.length === 0) {
    return undefined;
  }

  const run = observations.find(
    (envelope): envelope is ObservationEnvelope<AgentRunObservation> => envelope.observation.kind === 'agent_run'
  );
  if (!run) {
    return undefined;
  }

  return {
    run,
    observations,
  };
}
