import { ObservationReader } from './types';

export function createObservationReader(source: ObservationReader): ObservationReader {
  return {
    subscribe: (opts) => source.subscribe(opts),
    getMetricsSnapshot: () => source.getMetricsSnapshot(),
    listObservations: (opts) => source.listObservations(opts),
    getRun: (runId) => source.getRun(runId),
  };
}
