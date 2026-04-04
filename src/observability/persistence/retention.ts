import type { ObservationEnvelope } from '../types';
import type { ObservationPruneResult, ObservationRetentionPolicy } from './types';

export function applyObservationRetention(
  envelopes: ObservationEnvelope[],
  policy?: ObservationRetentionPolicy,
  now = Date.now()
): { envelopes: ObservationEnvelope[]; result: ObservationPruneResult } {
  if (!policy) {
    return {
      envelopes: [...envelopes],
      result: {
        deleted: 0,
        retained: envelopes.length,
      },
    };
  }

  let retained = [...envelopes];

  if (policy.maxAgeMs !== undefined) {
    const cutoff = now - Math.max(0, policy.maxAgeMs);
    retained = retained.filter((envelope) => envelope.timestamp >= cutoff);
  }

  if (policy.maxEntriesPerAgent !== undefined) {
    const maxEntries = Math.max(1, Math.floor(policy.maxEntriesPerAgent));
    const counts = new Map<string, number>();
    const next: ObservationEnvelope[] = [];

    for (let index = retained.length - 1; index >= 0; index--) {
      const envelope = retained[index];
      const agentId = envelope.observation.agentId;
      const count = counts.get(agentId) ?? 0;
      if (count >= maxEntries) {
        continue;
      }
      counts.set(agentId, count + 1);
      next.push(envelope);
    }

    retained = next.reverse();
  }

  return {
    envelopes: retained,
    result: {
      deleted: envelopes.length - retained.length,
      retained: retained.length,
    },
  };
}
