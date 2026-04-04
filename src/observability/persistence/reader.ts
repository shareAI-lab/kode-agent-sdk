import {
  buildObservationRunView,
  filterObservationEnvelopes,
  matchesObservationEnvelope,
} from '../query';
import type { ObservationEnvelope } from '../types';
import type {
  ObservationQueryBackend,
  PersistedObservationListOptions,
  PersistedObservationReader,
} from './types';

function sortObservationEnvelopes(envelopes: ObservationEnvelope[]): ObservationEnvelope[] {
  return [...envelopes].sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
    if (left.observation.agentId !== right.observation.agentId) {
      return left.observation.agentId.localeCompare(right.observation.agentId);
    }
    return left.seq - right.seq;
  });
}

function matchesPersistedObservationEnvelope(
  envelope: ObservationEnvelope,
  opts?: PersistedObservationListOptions
): boolean {
  if (!matchesObservationEnvelope(envelope, opts)) {
    return false;
  }

  if (opts?.agentIds && !opts.agentIds.includes(envelope.observation.agentId)) {
    return false;
  }

  if (opts?.templateIds) {
    const templateId =
      envelope.observation.metadata?.templateId &&
      typeof envelope.observation.metadata.templateId === 'string'
        ? envelope.observation.metadata.templateId
        : undefined;
    if (!templateId || !opts.templateIds.includes(templateId)) {
      return false;
    }
  }

  if (opts?.fromTimestamp !== undefined && envelope.timestamp < opts.fromTimestamp) {
    return false;
  }

  if (opts?.toTimestamp !== undefined && envelope.timestamp > opts.toTimestamp) {
    return false;
  }

  return true;
}

export function filterPersistedObservationEnvelopes(
  envelopes: ObservationEnvelope[],
  opts?: PersistedObservationListOptions
): ObservationEnvelope[] {
  const filtered = envelopes.filter((envelope) => matchesPersistedObservationEnvelope(envelope, opts));
  return filterObservationEnvelopes(sortObservationEnvelopes(filtered), opts);
}

export function buildPersistedObservationRunView(
  envelopes: ObservationEnvelope[],
  runId: string
) {
  return buildObservationRunView(sortObservationEnvelopes(envelopes), runId);
}

export function createStoreBackedObservationReader(
  backend: ObservationQueryBackend
): PersistedObservationReader {
  return {
    listObservations: (opts) => backend.list(opts),
    getRun: (runId) => backend.getRun(runId),
  };
}
